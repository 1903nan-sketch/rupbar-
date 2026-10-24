import type { RemoteCommand } from '@rupbar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db';
import { migrate, MIGRATIONS } from '../src/db/migrations';
import { category, Client, createEnv, createStaff, setupEstablishment, uuid, type TestEnv } from './helpers';

let env: TestEnv;
let owner: Client;
beforeEach(async () => {
  env = await createEnv();
  owner = await setupEstablishment(env);
});
afterEach(async () => {
  await env.app.close();
  env.s.close();
});

/** Comando como o painel online envia (o PC aplica uma única vez). */
const send = (type: RemoteCommand['type'], payload: Record<string, unknown>) =>
  env.s.sync.applyCommand({ id: uuid(), type, payload: { ...payload, registeredByName: 'Marina (painel online)' }, createdAt: new Date().toISOString(), createdBy: null });

/** Comanda da Lia com 10 Heinekens (R$ 120,00). */
async function comandaWithBeers() {
  const cat = await category(owner, 'Cervejas');
  const p = await owner.ok('POST', '/api/products', {
    name: 'Heineken long neck', categoryId: cat, measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 1200 }],
    initialStock: { qty: 24_000, totalCostCents: 12_000 },
  });
  const presentationId = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id as string;
  const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia', cardNumber: 14 });
  await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId, quantity: 10 }] });
  return c.id as string;
}

describe('desconto só do proprietário', () => {
  it('gerente e caixa não dão desconto direto; o gerente continua mudando a taxa de serviço', async () => {
    const comandaId = await comandaWithBeers();
    const manager = await createStaff(env, owner, 'manager', 'Rafael', 'rafael@bar.com');
    const d = await manager.ok('GET', `/api/comandas/${comandaId}`);
    const denied = await manager.fail('POST', `/api/comandas/${comandaId}/discount`, { discountCents: 500, reason: 'Cliente fiel', expectedVersion: d.version });
    expect(denied.status).toBe(403);
    // Nem com a permissão concedida antes da atualização (fica só com o proprietário).
    env.s.db.run(`UPDATE users SET grants_json = '["comandas.discount"]' WHERE name = 'Rafael'`);
    expect((await manager.fail('POST', `/api/comandas/${comandaId}/discount`, { discountCents: 500, reason: 'Cliente fiel', expectedVersion: d.version })).status).toBe(403);
    expect(await manager.ok('POST', `/api/comandas/${comandaId}/service-fee`, { serviceFeeBp: 1000, expectedVersion: d.version })).toMatchObject({ serviceFee: 1_200 });
    // O proprietário dá no PC normalmente.
    const v = (await owner.ok('GET', `/api/comandas/${comandaId}`)).version;
    expect(await owner.ok('POST', `/api/comandas/${comandaId}/discount`, { discountCents: 2_000, reason: 'Cliente fiel', expectedVersion: v })).toMatchObject({
      subtotal: 12_000, discount: 2_000, total: 11_000,
    });
  });

  it('funcionário pede, o proprietário aceita pelo painel e o funcionário recebe o aviso', async () => {
    const comandaId = await comandaWithBeers();
    const davi = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    env.s.ctx.setMeta('sync_enabled', '1');

    expect((await davi.fail('POST', `/api/comandas/${comandaId}/discount-requests`, { clientRequestId: uuid(), discountCents: 20_000, reason: 'Exagero' })).status).toBe(400);
    const key = uuid();
    const req = await davi.ok('POST', `/api/comandas/${comandaId}/discount-requests`, { clientRequestId: key, discountCents: 1_500, reason: 'Cerveja quente' });
    expect(req).toMatchObject({ status: 'pending', discountCents: 1_500, totalCents: 12_000, totalAfterCents: 10_500, requestedByName: 'Davi' });
    // Mesmo pedido de novo (toque duplo / sem rede) não duplica.
    expect((await davi.ok('POST', `/api/comandas/${comandaId}/discount-requests`, { clientRequestId: key, discountCents: 1_500, reason: 'Cerveja quente' })).id).toBe(req.id);
    expect((await davi.ok('GET', `/api/comandas/${comandaId}`)).discountRequest).toMatchObject({ id: req.id, status: 'pending' });
    // Vai para a nuvem (o painel do proprietário).
    expect(env.s.db.value("SELECT COUNT(*) FROM sync_outbox WHERE entity = 'discount_request'")).toBeGreaterThan(0);

    const r = await send('discount.approve', { requestId: req.id });
    expect(r).toMatchObject({ status: 'applied' });
    expect(r.message).toBe('Desconto de R$ 15,00 aplicado na Comanda 14 (fica R$ 105,00). Davi recebe o aviso.');
    const after = await davi.ok('GET', `/api/comandas/${comandaId}`);
    expect(after).toMatchObject({ discount: 1_500, discountReason: 'Cerveja quente', total: 10_500, discountRequest: null });

    const notices = await davi.ok('GET', '/api/discount-requests/notices');
    expect(notices).toEqual([expect.objectContaining({ id: req.id, status: 'approved', comandaLabel: 'Comanda 14', decidedByName: 'Marina (painel online)', totalAfterCents: 10_500 })]);
    expect(await owner.ok('GET', '/api/discount-requests/notices')).toEqual([]);
    await davi.ok('POST', `/api/discount-requests/${req.id}/seen`);
    expect(await davi.ok('GET', '/api/discount-requests/notices')).toEqual([]);
    // Responder de novo não aplica duas vezes.
    expect(await send('discount.approve', { requestId: req.id })).toMatchObject({ status: 'rejected', message: 'Este pedido de desconto já foi aceito.' });
  });

  it('recusa com aviso; pedido novo substitui o anterior; comanda encerrada cancela o pedido', async () => {
    const comandaId = await comandaWithBeers();
    const davi = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const ask = (cents: number) => davi.ok('POST', `/api/comandas/${comandaId}/discount-requests`, { clientRequestId: uuid(), discountCents: cents, reason: 'Pediu desconto' });

    const first = await ask(1_000);
    const second = await ask(2_000);
    expect(await send('discount.approve', { requestId: first.id })).toMatchObject({ status: 'rejected', message: expect.stringContaining('Substituído por um pedido novo') });
    expect(await send('discount.reject', { requestId: second.id, note: 'Hoje não' })).toMatchObject({ status: 'applied' });
    expect((await davi.ok('GET', `/api/comandas/${comandaId}`)).discount).toBe(0);
    expect(await davi.ok('GET', '/api/discount-requests/notices')).toEqual([expect.objectContaining({ id: second.id, status: 'rejected', decisionNote: 'Hoje não' })]);

    // Desistir do pedido.
    const third = await ask(500);
    await davi.ok('POST', `/api/discount-requests/${third.id}/cancel`);
    expect((await davi.ok('GET', `/api/comandas/${comandaId}`)).discountRequest).toBeNull();

    // Comanda paga e encerrada antes da resposta.
    const fourth = await ask(500);
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    await owner.ok('POST', '/api/payments', { comandaId, method: 'pix', amountCents: 12_000, clientRequestId: uuid() });
    const v = (await owner.ok('GET', `/api/comandas/${comandaId}`)).version;
    await owner.ok('POST', `/api/comandas/${comandaId}/close`, { expectedVersion: v });
    expect(env.s.db.value('SELECT status FROM discount_requests WHERE id = ?', fourth.id)).toBe('canceled');
    expect(await send('discount.approve', { requestId: fourth.id })).toMatchObject({ status: 'rejected', message: expect.stringContaining('Comanda encerrada') });
  });

  it('proprietário dá o desconto direto pelo painel (e tira); o valor pago nunca fica maior que o total', async () => {
    const comandaId = await comandaWithBeers();
    const davi = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const pending = await davi.ok('POST', `/api/comandas/${comandaId}/discount-requests`, { clientRequestId: uuid(), discountCents: 1_000, reason: 'Pediu' });

    expect(await send('comanda.discount', { comandaId, discountCents: 2_000, reason: 'Aniversário' })).toMatchObject({
      status: 'applied', message: 'Desconto de R$ 20,00 na Comanda 14 (fica R$ 100,00).',
    });
    expect(env.s.db.value('SELECT status FROM discount_requests WHERE id = ?', pending.id)).toBe('canceled');
    expect(await send('comanda.discount', { comandaId, discountCents: 0, reason: 'Desconto tirado' })).toMatchObject({ status: 'applied', message: 'Desconto tirado da Comanda 14.' });

    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    await owner.ok('POST', '/api/payments', { comandaId, method: 'pix', amountCents: 11_000, clientRequestId: uuid() });
    expect((await send('comanda.discount', { comandaId, discountCents: 2_000, reason: 'Aniversário' })).message).toMatch(/valor pago maior que o total/);
    expect((await davi.fail('POST', `/api/comandas/${comandaId}/discount-requests`, { clientRequestId: uuid(), discountCents: 2_000, reason: 'Pediu' })).code).toBe('PAID_EXCEEDS_TOTAL');
  });
});

describe('atualização do banco', () => {
  it('quem mudava a taxa junto com o desconto continua mudando a taxa; pedidos de desconto sincronizam', () => {
    const db = new Db(':memory:');
    try {
      db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const m of MIGRATIONS.filter((x) => x.id < 14)) {
        db.exec(m.sql);
        m.run?.(db);
        db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)', m.id, m.name, '2026-01-01T00:00:00Z');
      }
      db.run(`INSERT INTO roles (id, key, name, permissions_json, created_at, updated_at) VALUES ('r1', 'manager', 'Gerente', '["comandas.view","comandas.discount"]', 'x', 'x')`);
      db.run(`INSERT INTO roles (id, key, name, permissions_json, created_at, updated_at) VALUES ('r2', 'waiter', 'Garçom', '["comandas.view"]', 'x', 'x')`);
      db.run(`INSERT INTO users (id, name, email, password_hash, role_id, grants_json, created_at, updated_at) VALUES ('u1', 'Davi', 'd@x', 'h', 'r2', '["comandas.discount"]', 'x', 'x')`);
      expect(migrate(db).applied).toEqual(MIGRATIONS.filter((x) => x.id >= 14).map((x) => x.id));
      expect(JSON.parse(db.value<string>("SELECT permissions_json FROM roles WHERE id = 'r1'")!)).toEqual(['comandas.view', 'comandas.discount', 'comandas.service_fee']);
      expect(JSON.parse(db.value<string>("SELECT permissions_json FROM roles WHERE id = 'r2'")!)).toEqual(['comandas.view']);
      expect(JSON.parse(db.value<string>("SELECT grants_json FROM users WHERE id = 'u1'")!)).toEqual(['comandas.discount', 'comandas.service_fee']);
      expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_discount_requests_%' ORDER BY name").map((r) => r.name)).toEqual([
        'sync_discount_requests_ins', 'sync_discount_requests_upd',
      ]);
    } finally {
      db.close();
    }
  });
});
