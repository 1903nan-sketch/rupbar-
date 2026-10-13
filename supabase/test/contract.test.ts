/**
 * Teste de contrato PC ⇄ nuvem: o motor de sincronização REAL do servidor
 * local conversa com as funções SQL REAIS da migração (em PGlite), como se o
 * PostgREST estivesse no meio. Cobre envio, minimização de dados, perda
 * registrada no site, aplicação única e confirmação.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/http/app';
import { setPasswordHashCost } from '../../apps/server/src/lib/crypto';
import { createServices } from '../../apps/server/src/services';
import type { CloudApi } from '../../apps/server/src/services/sync';

setPasswordHashCost(1 << 10);
const root = join(__dirname, '..');
let pg: PGlite;
const OWNER_ID = randomUUID();

async function as<T>(role: 'anon' | 'authenticated', sub: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false); set role ${role};`);
  try {
    return await fn();
  } finally {
    await pg.exec('reset role');
  }
}

/** Simula uma chamada RPC do PostgREST (parâmetros JSON chegam como jsonb). */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const names = Object.keys(args);
  const values = names.map((n) => {
    const v = args[n];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const r = await pg.query<{ r: T }>(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, values);
  return r.rows[0]!.r;
}

const pgCloud: CloudApi = {
  async signIn(_url, _key, email, password) {
    if (email !== 'dona@bar.com' || password !== 'senha-nuvem-1') throw new Error('Invalid login credentials');
    return { accessToken: OWNER_ID };
  },
  async registerDevice(_url, _key, token, args) {
    const r = await as('authenticated', token, () =>
      rpc<{ device_id: string; device_secret: string; establishment_id: string }>('rupbar_register_device', {
        p_establishment_id: args.establishmentId, p_device_name: args.name, p_trade_name: args.tradeName,
      }),
    );
    return { deviceId: r.device_id, deviceSecret: r.device_secret, establishmentId: r.establishment_id };
  },
  push: (cfg, records) => as('anon', null, () => rpc('rupbar_device_push', { p_device_id: cfg.deviceId, p_secret: cfg.secret, p_records: records })),
  pull: (cfg, limit) => as('anon', null, () => rpc('rupbar_device_pull', { p_device_id: cfg.deviceId, p_secret: cfg.secret, p_limit: limit })),
  ack: async (cfg, results) => {
    await as('anon', null, () => rpc('rupbar_device_ack', { p_device_id: cfg.deviceId, p_secret: cfg.secret, p_results: results }));
  },
  heartbeat: async (cfg, status) => {
    await as('anon', null, () => rpc('rupbar_device_heartbeat', { p_device_id: cfg.deviceId, p_secret: cfg.secret, p_status: status }));
  },
};

const dataDir = mkdtempSync(join(tmpdir(), 'rupbar-contract-'));
const s = createServices({
  config: { dataDir, attachmentsDir: join(dataDir, 'a'), logsDir: join(dataDir, 'l'), backupsDir: join(dataDir, 'b'), port: 7420, uiDir: null, version: 'contract' },
  dbPath: ':memory:',
  masterKey: randomBytes(32),
  cloudApi: pgCloud,
});
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({
    method: method as 'GET', url, remoteAddress: '127.0.0.1',
    headers: { 'x-rupbar': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const c = res.cookies.find((x) => x.name === 'rupbar_session');
  if (c) cookie = `rupbar_session=${c.value}`;
  if (res.statusCode >= 400) throw new Error(`${url}: ${res.body}`);
  return res.json();
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(join(__dirname, 'stub.sql'), 'utf8'));
  for (const f of readdirSync(join(root, 'migrations')).sort()) await pg.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [OWNER_ID, 'dona@bar.com']);
  app = await buildApp(s);
  await call('POST', '/api/setup', {
    identity: { tradeName: 'Bar Contrato' },
    owner: { name: 'Dona Lu', email: 'dona@bar.com', password: 'Bar-Contrato-2026' },
  });
});
afterAll(async () => {
  await app.close();
  s.close();
});

describe('contrato PC ⇄ Supabase', () => {
  it('sincroniza, aplica perda do site uma única vez e devolve o resultado', async () => {
    const cats = await call('GET', '/api/categories');
    const product = await call('POST', '/api/products', {
      name: 'Gin Tanqueray 750 ml', categoryId: cats.find((c: { name: string }) => c.name === 'Destilados').id, measure: 'volume',
      packageQty: 750_000, presentations: [{ name: 'Dose 50 ml', priceCents: 2500, components: [{ productId: null, qty: 50_000 }] }],
    });
    await call('POST', '/api/stock/purchases', { items: [{ productId: product.id, packages: 2, packageQty: 750_000, totalCostCents: 18_000 }] });
    await call('POST', '/api/comandas', { customerName: 'Paula', customerCpf: '529.982.247-25', customerPhone: '11987654321' });

    await call('POST', '/api/sync/connect', { supabaseUrl: 'https://exemplo.supabase.co', anonKey: 'anon-key-0123456789abcdef', email: 'dona@bar.com', password: 'senha-nuvem-1' });
    const st = await s.sync.runOnce();
    expect(st.status).toBe('synced');

    const products = await as('authenticated', OWNER_ID, () => pg.query<{ name: string; stock_qty: string }>('select name, stock_qty from v_products'));
    expect(products.rows).toHaveLength(1);
    expect(Number(products.rows[0]!.stock_qty)).toBe(1_500_000);
    const raw = await pg.query<{ data: unknown }>('select data from sync_records');
    const dump = JSON.stringify(raw.rows);
    expect(dump).not.toMatch(/52998224725|987654321|scrypt\$/);

    // Proprietário registra perda no site (PC "offline" até o próximo ciclo)
    const est = (await call('GET', '/api/branding')).establishmentId;
    const cmd = await as('authenticated', OWNER_ID, () =>
      rpc<string>('rupbar_owner_register_loss', { p_establishment_id: est, p_product_id: product.id, p_qty: 100_000, p_unit: 'ml', p_reason: 'spilled', p_occurred_at: null, p_notes: 'garrafa caiu' }),
    );
    expect((await pg.query<{ status: string }>('select status from remote_commands where id = $1', [cmd])).rows[0]!.status).toBe('pending');

    await s.sync.runOnce();
    expect((await call('GET', `/api/products/${product.id}`)).stockQty).toBe(1_400_000);
    const remote = await pg.query<{ status: string; result: { status: string } }>('select status, result from remote_commands where id = $1', [cmd]);
    expect(remote.rows[0]!.status).toBe('applied');
    // A perda aplicada e o novo saldo chegam à nuvem
    await s.sync.runOnce();
    const loss = await as('authenticated', OWNER_ID, () => pg.query<{ status: string; cost_cents: string }>('select status, cost_cents from v_losses where remote_command_id = $1', [cmd]));
    expect(loss.rows[0]!.status).toBe('applied');
    expect(Number(loss.rows[0]!.cost_cents)).toBe(1200); // R$ 180 / 1500 ml = R$ 0,12/ml × 100 ml
    const after = await as('authenticated', OWNER_ID, () => pg.query<{ stock_qty: string }>('select stock_qty from v_products'));
    expect(Number(after.rows[0]!.stock_qty)).toBe(1_400_000);

    // Reprocessar não aplica de novo
    await pg.query("update remote_commands set status = 'delivered' where id = $1", [cmd]);
    await s.sync.runOnce();
    expect((await call('GET', `/api/products/${product.id}`)).stockQty).toBe(1_400_000);

    const dev = await as('authenticated', OWNER_ID, () => pg.query<{ last_sync_at: string | null; pending_count: number }>('select last_sync_at, pending_count from devices where revoked_at is null'));
    expect(dev.rows[0]!.last_sync_at).not.toBeNull();
  });
});
