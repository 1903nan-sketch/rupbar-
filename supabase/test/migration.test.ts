/**
 * Testa a migração da nuvem em um Postgres real (PGlite/WASM), incluindo RLS,
 * credenciais de dispositivo, upsert por versão e a fila de perdas remotas.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
let db: PGlite;
const OWNER = randomUUID();
const OTHER = randomUUID();
const EST = randomUUID();
const PRODUCT = randomUUID();

async function as<T>(role: 'anon' | 'authenticated' | 'postgres', sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false);`);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

async function rpc<T = unknown>(fnName: string, args: Record<string, unknown>): Promise<T> {
  const names = Object.keys(args);
  const sql = `select public.${fnName}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  const res = await db.query<{ r: T }>(sql, names.map((n) => (typeof args[n] === 'object' && args[n] !== null && !Array.isArray(args[n]) ? JSON.stringify(args[n]) : args[n])));
  return res.rows[0]!.r;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(join(__dirname, 'stub.sql'), 'utf8'));
  for (const f of readdirSync(join(root, 'migrations')).sort()) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [OWNER, 'marina@bar.com', OTHER, 'intruso@x.com']);
});

describe('nuvem RupBar', () => {
  let device: { device_id: string; device_secret: string };

  it('registra o PC com o login do proprietário e guarda apenas o hash do segredo', async () => {
    device = await as('authenticated', OWNER, () => rpc('rupbar_register_device', { p_establishment_id: EST, p_device_name: 'PC do bar', p_trade_name: 'Bar da Marina' }));
    expect(device.device_secret).toHaveLength(64);
    const stored = await db.query<{ secret_hash: string }>('select secret_hash from devices where id = $1', [device.device_id]);
    expect(stored.rows[0]!.secret_hash).not.toContain(device.device_secret);
    // Outra conta não pode sequestrar o estabelecimento
    await expect(as('authenticated', OTHER, () => rpc('rupbar_register_device', { p_establishment_id: EST, p_device_name: 'x', p_trade_name: 'x' }))).rejects.toThrow(/outra conta/);
    // Anônimo não registra
    await expect(as('anon', null, () => rpc('rupbar_register_device', { p_establishment_id: EST, p_device_name: 'x', p_trade_name: 'x' }))).rejects.toThrow();
  });

  it('push idempotente por versão; credencial inválida é recusada', async () => {
    const rec = (version: number, stock: number) => ({
      outboxId: `product:${PRODUCT}:${version}`, entity: 'product', id: PRODUCT, version, deleted: false,
      data: { name: 'Cerveja', stock_qty: stock, stock_tracked: 1, measure: 'unit', category_id: null, unit_cost_e4: 45000, active: 1 }, updatedAt: new Date().toISOString(),
    });
    const r1 = await as('anon', null, () => rpc<{ acked: string[] }>('rupbar_device_push', { p_device_id: device.device_id, p_secret: device.device_secret, p_records: [rec(5, 24000)] }));
    expect(r1.acked).toEqual([`product:${PRODUCT}:5`]);
    // versão antiga chega depois: aceita (ack) mas não sobrescreve
    await as('anon', null, () => rpc('rupbar_device_push', { p_device_id: device.device_id, p_secret: device.device_secret, p_records: [rec(3, 99000)] }));
    // reenvio da mesma versão: sem efeito
    await as('anon', null, () => rpc('rupbar_device_push', { p_device_id: device.device_id, p_secret: device.device_secret, p_records: [rec(5, 24000)] }));
    const row = await db.query<{ version: string; stock: string }>("select version, data->>'stock_qty' as stock from sync_records where id = $1", [PRODUCT]);
    expect(row.rows[0]).toMatchObject({ stock: '24000' });
    expect(Number(row.rows[0]!.version)).toBe(5);
    await expect(as('anon', null, () => rpc('rupbar_device_push', { p_device_id: device.device_id, p_secret: 'errado', p_records: [] }))).rejects.toThrow(/não autorizado/);
    // registro de entidade desconhecida é rejeitado, os demais seguem
    const r2 = await as('anon', null, () => rpc<{ acked: string[]; rejected: unknown[] }>('rupbar_device_push', {
      p_device_id: device.device_id, p_secret: device.device_secret,
      p_records: [{ outboxId: 'x:1:1', entity: 'senhas', id: randomUUID(), version: 1, data: {} }],
    }));
    expect(r2.rejected).toHaveLength(1);
  });

  it('RLS: o proprietário lê seus dados; outra conta e anônimo não leem nada', async () => {
    const mine = await as('authenticated', OWNER, () => db.query<{ name: string; stock_qty: number }>('select name, stock_qty from v_products'));
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]!.name).toBe('Cerveja');
    expect(Number(mine.rows[0]!.stock_qty)).toBe(24000);
    const theirs = await as('authenticated', OTHER, () => db.query('select * from sync_records'));
    expect(theirs.rows).toHaveLength(0);
    await expect(as('anon', null, () => db.query('select * from sync_records'))).rejects.toThrow();
    // ninguém escreve direto nas tabelas
    await expect(as('authenticated', OWNER, () => db.query("update sync_records set data = '{}'"))).rejects.toThrow();
    await expect(as('authenticated', OWNER, () => db.query("insert into remote_commands (establishment_id, type, payload) values ($1, 'loss.register', '{}')", [EST]))).rejects.toThrow();
  });

  it('perda pelo site: validada, aguarda aplicação, é entregue ao PC e confirmada uma vez', async () => {
    await expect(as('authenticated', OTHER, () => rpc('rupbar_owner_register_loss', { p_establishment_id: EST, p_product_id: PRODUCT, p_qty: 1000, p_unit: 'un', p_reason: 'broken', p_occurred_at: null, p_notes: null }))).rejects.toThrow(/proprietário/);
    await expect(as('authenticated', OWNER, () => rpc('rupbar_owner_register_loss', { p_establishment_id: EST, p_product_id: PRODUCT, p_qty: -1, p_unit: 'un', p_reason: 'broken', p_occurred_at: null, p_notes: null }))).rejects.toThrow(/Quantidade/);
    await expect(as('authenticated', OWNER, () => rpc('rupbar_owner_register_loss', { p_establishment_id: EST, p_product_id: randomUUID(), p_qty: 1000, p_unit: 'un', p_reason: 'broken', p_occurred_at: null, p_notes: null }))).rejects.toThrow(/Produto/);
    const cmdId = await as('authenticated', OWNER, () => rpc<string>('rupbar_owner_register_loss', { p_establishment_id: EST, p_product_id: PRODUCT, p_qty: 2000, p_unit: 'un', p_reason: 'broken', p_occurred_at: null, p_notes: 'caiu' }));
    const pending = await as('authenticated', OWNER, () => db.query<{ status: string }>('select status from remote_commands where id = $1', [cmdId]));
    expect(pending.rows[0]!.status).toBe('pending');
    // saldo operacional na nuvem NÃO muda antes da confirmação do PC
    const stock = await as('authenticated', OWNER, () => db.query<{ stock_qty: number }>('select stock_qty from v_products'));
    expect(Number(stock.rows[0]!.stock_qty)).toBe(24000);

    const pulled = await as('anon', null, () => rpc<{ id: string; payload: { qty: number; registeredByName: string } }[]>('rupbar_device_pull', { p_device_id: device.device_id, p_secret: device.device_secret, p_limit: 10 }));
    expect(pulled).toHaveLength(1);
    expect(pulled[0]!.payload).toMatchObject({ qty: 2000, registeredByName: 'marina@bar.com (painel online)' });
    // sem confirmação, é reentregue (PC aplica de forma idempotente)
    const again = await as('anon', null, () => rpc<unknown[]>('rupbar_device_pull', { p_device_id: device.device_id, p_secret: device.device_secret, p_limit: 10 }));
    expect(again).toHaveLength(1);
    // proprietário não pode cancelar depois da entrega
    expect(await as('authenticated', OWNER, () => rpc<boolean>('rupbar_owner_cancel_command', { p_command_id: cmdId }))).toBe(false);
    await as('anon', null, () => rpc('rupbar_device_ack', {
      p_device_id: device.device_id, p_secret: device.device_secret,
      p_results: [{ commandId: cmdId, status: 'applied', message: 'ok', appliedAt: new Date().toISOString() }],
    }));
    const done = await as('authenticated', OWNER, () => db.query<{ status: string }>('select status from remote_commands where id = $1', [cmdId]));
    expect(done.rows[0]!.status).toBe('applied');
    const empty = await as('anon', null, () => rpc<unknown[]>('rupbar_device_pull', { p_device_id: device.device_id, p_secret: device.device_secret, p_limit: 10 }));
    expect(empty).toHaveLength(0);
  });

  it('heartbeat registra última sincronização; novo registro revoga o PC anterior', async () => {
    await as('anon', null, () => rpc('rupbar_device_heartbeat', { p_device_id: device.device_id, p_secret: device.device_secret, p_status: { pending: 3, version: '0.1.0' } }));
    const d = await as('authenticated', OWNER, () => db.query<{ pending_count: number; last_sync_at: string | null }>('select pending_count, last_sync_at from devices where id = $1', [device.device_id]));
    expect(d.rows[0]).toMatchObject({ pending_count: 3 });
    expect(d.rows[0]!.last_sync_at).not.toBeNull();
    await as('authenticated', OWNER, () => rpc('rupbar_register_device', { p_establishment_id: EST, p_device_name: 'PC novo', p_trade_name: 'Bar da Marina' }));
    await expect(as('anon', null, () => rpc('rupbar_device_heartbeat', { p_device_id: device.device_id, p_secret: device.device_secret, p_status: {} }))).rejects.toThrow(/não autorizado/);
  });

  it('relatórios agregados respeitam o RLS', async () => {
    const summary = await as('authenticated', OWNER, () => rpc<{ grossCents: number }>('rupbar_sales_summary', { p_establishment_id: EST, p_from: '2020-01-01', p_to: '2100-01-01' }));
    expect(summary.grossCents).toBe(0);
    const other = await as('authenticated', OTHER, () => rpc<{ grossCents: number; byDay: unknown[] }>('rupbar_sales_summary', { p_establishment_id: EST, p_from: '2020-01-01', p_to: '2100-01-01' }));
    expect(other.byDay).toEqual([]);
  });
});
