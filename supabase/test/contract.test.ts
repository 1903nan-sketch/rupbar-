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
import { barDay } from '../../packages/core/src/report';

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

  it('painel operando: abre caixa e comanda, lança e tira item, exclui funcionário e tira produto da venda', async () => {
    const est = (await call('GET', '/api/branding')).establishmentId as string;
    const owner = (type: string, payload: Record<string, unknown>) =>
      as('authenticated', OWNER_ID, () => rpc<string>('rupbar_owner_command', { p_establishment_id: est, p_type: type, p_payload: payload }));
    const statusOf = async (id: string) => (await pg.query<{ status: string; result: { message: string } }>('select status, result from remote_commands where id = $1', [id])).rows[0]!;

    // O site lista as apresentações à venda (nome e preço) a partir do que o PC enviou.
    await s.sync.runOnce();
    const pres = await as('authenticated', OWNER_ID, () => pg.query<{ id: string; name: string; price_cents: string }>('select id, name, price_cents from v_presentations where active'));
    const dose = pres.rows.find((r) => r.name === 'Dose 50 ml')!;
    expect(Number(dose.price_cents)).toBe(2500);

    const cash = await owner('cash.open', { openingBalanceCents: 5_000, label: 'Abrir caixa' });
    const open = await owner('comanda.open', { customerName: 'Rita', cardNumber: 33, table: null, label: 'Cartão 33 · Rita' });
    await s.sync.runOnce(); // PC recebe, aplica e confirma
    expect(await statusOf(cash)).toMatchObject({ status: 'applied', result: { message: 'Caixa 1 aberto.' } });
    expect(await statusOf(open)).toMatchObject({ status: 'applied', result: { message: 'Comanda 33 aberta.' } });
    await s.sync.runOnce(); // a comanda nova chega à nuvem
    const comanda = (await as('authenticated', OWNER_ID, () => pg.query<{ id: string; status: string }>("select id, status from v_comandas where card_number = 33"))).rows[0]!;
    expect(comanda.status).toBe('open');

    const order = await owner('order.create', { comandaId: comanda.id, items: [{ presentationId: dose.id, quantity: 2 }], label: 'Cartão 33: 2× Gin' });
    await s.sync.runOnce();
    expect((await statusOf(order)).status).toBe('applied');
    await s.sync.runOnce();
    const items = await as('authenticated', OWNER_ID, () => pg.query<{ id: string; quantity: number; status: string }>('select id, quantity, status from v_comanda_items where comanda_id = $1', [comanda.id]));
    expect(items.rows).toMatchObject([{ quantity: 2, status: 'active' }]);

    const cancel = await owner('comanda_item.cancel', { itemId: items.rows[0]!.id, reason: 'Lançado errado' });
    await s.sync.runOnce();
    expect((await statusOf(cancel)).status).toBe('applied');

    // Recusa com o motivo, sem aplicar nada (cartão já em uso).
    const dup = await owner('comanda.open', { customerName: 'Outra', cardNumber: 33 });
    await s.sync.runOnce();
    expect(await statusOf(dup)).toMatchObject({ status: 'rejected' });

    const staff = await call('POST', '/api/users', { name: 'Caio', email: 'caio@bar.com', roleId: (await call('GET', '/api/roles')).find((r: { key: string }) => r.key === 'waiter').id });
    await s.sync.runOnce();
    const removed = await owner('user.remove', { userId: staff.id });
    const productOff = await owner('product.set_active', { productId: (await call('GET', '/api/products'))[0].id, active: false });
    await s.sync.runOnce();
    await s.sync.runOnce();
    expect((await statusOf(removed)).status).toBe('applied');
    expect((await statusOf(productOff)).status).toBe('applied');
    const users = await as('authenticated', OWNER_ID, () => pg.query<{ name: string; status: string }>("select name, status from v_users where status <> 'removed' order by name"));
    expect(users.rows.map((u) => u.name)).toEqual(['Dona Lu']);
    const products = await as('authenticated', OWNER_ID, () => pg.query<{ active: boolean }>('select active from v_products'));
    expect(products.rows[0]!.active).toBe(false);
  });

  it('desconto: o funcionário pede no PC, o proprietário aceita no painel e o desconto volta aplicado', async () => {
    const est = (await call('GET', '/api/branding')).establishmentId as string;
    const owner = (type: string, payload: Record<string, unknown>) =>
      as('authenticated', OWNER_ID, () => rpc<string>('rupbar_owner_command', { p_establishment_id: est, p_type: type, p_payload: payload }));
    const statusOf = async (id: string) => (await pg.query<{ status: string; result: { message: string } }>('select status, result from remote_commands where id = $1', [id])).rows[0]!;
    const cats = await call('GET', '/api/categories');
    const beer = await call('POST', '/api/products', {
      name: 'Heineken long neck', categoryId: cats.find((c: { name: string }) => c.name === 'Cervejas').id, measure: 'unit',
      presentations: [{ name: 'Unidade', priceCents: 1200 }], initialStock: { qty: 24_000, totalCostCents: 12_000 },
    });
    const presentationId = (await call('GET', `/api/products/${beer.id}`)).presentations[0].id;
    const comanda = await call('POST', '/api/comandas', { customerName: 'Bruno', cardNumber: 14 });
    await call('POST', '/api/orders', { comandaId: comanda.id, clientRequestId: randomUUID(), items: [{ presentationId, quantity: 10 }] });

    // Garçom entra no PC (outra sessão) e pede o desconto.
    const role = (await call('GET', '/api/roles')).find((r: { key: string }) => r.key === 'waiter').id;
    const davi = await call('POST', '/api/users', { name: 'Davi', email: 'davi@bar.com', roleId: role });
    let waiterCookie = '';
    const waiter = async (method: string, url: string, body?: unknown) => {
      const res = await app.inject({
        method: method as 'GET', url, remoteAddress: '192.168.0.50',
        headers: { 'x-rupbar': '1', ...(waiterCookie ? { cookie: waiterCookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        payload: body ? JSON.stringify(body) : undefined,
      });
      const c = res.cookies.find((x) => x.name === 'rupbar_session');
      if (c) waiterCookie = `rupbar_session=${c.value}`;
      if (res.statusCode >= 400) throw new Error(`${url}: ${res.body}`);
      return res.json();
    };
    await waiter('POST', '/api/auth/login', { email: 'davi@bar.com', password: davi.temporaryPassword });
    await waiter('POST', '/api/auth/change-password', { currentPassword: davi.temporaryPassword, newPassword: 'Senha-Forte-99' });
    const req = await waiter('POST', `/api/comandas/${comanda.id}/discount-requests`, { clientRequestId: randomUUID(), discountCents: 2_000, reason: 'Levou caixa fechada' });

    await s.sync.runOnce(); // o pedido chega ao painel
    const pending = await as('authenticated', OWNER_ID, () => pg.query('select requested_by_name, discount_cents, total_cents, total_after_cents, status, reason from v_discount_requests where id = $1', [req.id]));
    expect(pending.rows[0]).toEqual({ requested_by_name: 'Davi', discount_cents: 2_000, total_cents: 12_000, total_after_cents: 10_000, status: 'pending', reason: 'Levou caixa fechada' });
    await expect(as('anon', null, () => pg.query('select id from v_discount_requests'))).rejects.toThrow(/permission denied/);

    const approve = await owner('discount.approve', { requestId: req.id });
    await s.sync.runOnce(); // o PC aplica e confirma
    expect(await statusOf(approve)).toMatchObject({ status: 'applied', result: { message: expect.stringContaining('Desconto de R$ 20,00 aplicado na Comanda 14') } });
    expect(await waiter('GET', '/api/discount-requests/notices')).toEqual([expect.objectContaining({ status: 'approved', comandaLabel: 'Comanda 14' })]);
    await s.sync.runOnce(); // a resposta e a comanda com desconto chegam à nuvem
    const done = await as('authenticated', OWNER_ID, () => pg.query<{ status: string }>('select status from v_discount_requests where id = $1', [req.id]));
    expect(done.rows[0]!.status).toBe('approved');
    const c = await as('authenticated', OWNER_ID, () => pg.query('select discount_cents, discount_reason from v_comandas where id = $1', [comanda.id]));
    expect(c.rows[0]).toEqual({ discount_cents: 2_000, discount_reason: 'Levou caixa fechada' });

    // O proprietário também dá (e tira) desconto direto pelo painel.
    const direct = await owner('comanda.discount', { comandaId: comanda.id, discountCents: 3_000, reason: 'Aniversário' });
    await s.sync.runOnce();
    expect(await statusOf(direct)).toMatchObject({ status: 'applied', result: { message: 'Desconto de R$ 30,00 na Comanda 14 (fica R$ 90,00).' } });

  });

  it('relatório completo: o painel online mostra exatamente o que o PC mostra', async () => {
    const est = (await call('GET', '/api/branding')).establishmentId as string;
    // O proprietário encerra pelo painel a comanda com desconto (R$ 90: Pix + dinheiro no caixa aberto).
    const owner = (type: string, payload: Record<string, unknown>) =>
      as('authenticated', OWNER_ID, () => rpc<string>('rupbar_owner_command', { p_establishment_id: est, p_type: type, p_payload: payload }));
    const comanda = (await call('GET', '/api/comandas')).find((c: { cardNumber: number | null }) => c.cardNumber === 14);
    const close = await owner('comanda.close', { comandaId: comanda.id, payments: [{ method: 'pix', amountCents: 5_000 }, { method: 'cash', amountCents: 4_000 }] });
    await s.sync.runOnce(); // o PC recebe, registra os pagamentos e encerra
    const applied = (await pg.query<{ status: string; result: { message: string } }>('select status, result from remote_commands where id = $1', [close])).rows[0]!;
    expect(applied).toMatchObject({ status: 'applied', result: { message: 'Comanda 14 encerrada (Pix R$ 50,00 + Dinheiro R$ 40,00). Total R$ 90,00.' } });
    expect(await call('GET', `/api/comandas/${comanda.id}`)).toMatchObject({ status: 'closed', paid: 9_000 });
    await call('POST', '/api/cash/movements', { type: 'withdrawal', amountCents: 1_000, reason: 'Gelo', clientRequestId: randomUUID() });
    await s.sync.runOnce();
    await s.sync.runOnce();

    const de = barDay();
    const pc = await call('GET', `/api/reports/full?de=${de}`);
    const cloud = await as('authenticated', OWNER_ID, () => rpc<Record<string, unknown>>('rupbar_full_report', { p_establishment_id: est, p_de: de, p_ate: de }));
    const strip = (r: Record<string, unknown>) => ({ ...r, generatedAt: null });
    expect(pc.summary.grossCents).toBeGreaterThan(0);
    expect(pc.discounts.length).toBeGreaterThan(0);
    expect(pc.cashSessions.length).toBeGreaterThan(0);
    expect(strip(cloud)).toEqual(strip(pc));
    // A comanda encerrada pelo painel volta para a nuvem encerrada, com os pagamentos.
    const closed = await as('authenticated', OWNER_ID, () => pg.query<{ status: string }>('select status from v_comandas where id = $1', [comanda.id]));
    expect(closed.rows[0]!.status).toBe('closed');
    const pays = await as('authenticated', OWNER_ID, () => pg.query<{ method: string; amount_cents: string }>("select method, amount_cents from v_payments where comanda_id = $1 and status = 'active' order by amount_cents desc", [comanda.id]));
    expect(pays.rows.map((p) => [p.method, Number(p.amount_cents)])).toEqual([['pix', 5_000], ['cash', 4_000]]);
    // Outra conta não vê nada.
    const other = await as('authenticated', randomUUID(), () => rpc<{ summary: { grossCents: number } }>('rupbar_full_report', { p_establishment_id: est, p_de: de, p_ate: de }));
    expect(other.summary.grossCents).toBe(0);
  });
});
