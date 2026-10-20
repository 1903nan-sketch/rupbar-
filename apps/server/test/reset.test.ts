import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { category, Client, createEnv, createStaff, OWNER, setupEstablishment, uuid, type TestEnv } from './helpers';

let env: TestEnv;
let owner: Client;

beforeEach(async () => {
  env = await createEnv();
  owner = await setupEstablishment(env);
  // Com a nuvem ligada, toda alteração entra na fila de sincronização.
  env.s.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_enabled', '1')");
});
afterEach(async () => {
  await env.app.close();
  env.s.close();
});

const reset = (body: Record<string, unknown>) => owner.req('POST', '/api/admin/test-data/reset', body);

/** Um dia de testes: produtos, escolha, entrada, caixa, comanda paga, venda rápida e dois narguilés. */
async function testDay() {
  const beerCat = await category(owner, 'Cervejas');
  const beer = await owner.ok('POST', '/api/products', {
    name: 'Heineken long neck', categoryId: beerCat, measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 1200 }],
    initialStock: { qty: 48_000, totalCostCents: 24_000 },
  });
  const pres = (await owner.ok('GET', `/api/products/${beer.id}`)).presentations[0].id;
  await owner.ok('POST', '/api/option-groups', { name: 'Gelo', choices: [{ name: 'Coco', productId: beer.id, qty: 1000 }] });
  await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 5_000 });
  const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia', cardNumber: 12 });
  await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 3 }] });
  const pay = await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'cash', amountCents: 3_600, clientRequestId: uuid() });
  await owner.ok('POST', `/api/comandas/${c.id}/close`, { expectedVersion: pay.comanda.version });
  await owner.ok('POST', '/api/quick-sales', { clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }], payments: [{ method: 'pix', amountCents: 1_200 }] });
  const house = await owner.ok('POST', '/api/hookahs', { code: 'N-01' });
  const open = await owner.ok('POST', '/api/comandas', { customerName: 'Rafa' });
  await owner.ok('POST', '/api/hookah-sessions', { hookahId: house.id, comandaId: open.id, clientRequestId: uuid() });
  await owner.ok('POST', '/api/hookah-sessions', { mode: 'own', ownLabel: 'preto', comandaId: open.id, clientRequestId: uuid() });
  return { beer, closedComanda: c, house };
}

describe('conta mestre: apagar dados de teste', () => {
  it('mostra o que vai sair, pede a senha do proprietário e apaga vendas, caixas, estoque e produtos', async () => {
    const { beer, closedComanda, house } = await testDay();
    const preview = await owner.ok('GET', '/api/admin/test-data');
    expect(preview).toMatchObject({ comandas: 3, salesCents: 4_800, cashSessions: 1, openCashSessions: 1, openComandas: 1, products: 1, hookahSessions: 2, cloud: true });

    const manager = await createStaff(env, owner, 'manager', 'Gerente', 'g@bar.com');
    expect((await manager.fail('GET', '/api/admin/test-data')).status).toBe(403);
    expect((await manager.fail('POST', '/api/admin/test-data/reset', { password: 'Senha-Forte-99', confirm: 'APAGAR' })).status).toBe(403);
    expect((await reset({ password: 'errada', confirm: 'APAGAR' })).json().error.code).toBe('BAD_PASSWORD');
    expect((await reset({ password: OWNER.password, confirm: 'apaga' })).json().error.code).toBe('VALIDATION');
    expect(env.s.db.value('SELECT COUNT(*) FROM comandas')).toBe(3);

    const done = await owner.ok('POST', '/api/admin/test-data/reset', { password: OWNER.password, confirm: ' apagar ' });
    expect(done.backup).toMatch(/^antes-de-apagar-testes-.*\.db$/);
    expect(readdirSync(env.s.ctx.config.backupsDir)).toContain(done.backup);

    for (const table of ['comandas', 'orders', 'comanda_items', 'payments', 'cash_sessions', 'hookah_sessions', 'stock_movements', 'purchases', 'products', 'presentations', 'option_groups', 'print_jobs']) {
      expect(env.s.db.value(`SELECT COUNT(*) FROM ${table}`), table).toBe(0);
    }
    expect((await owner.ok('GET', '/api/cash/current')).session ?? null).toBeNull();
    // As travas contra apagar pagamentos e movimentações voltaram.
    expect(env.s.db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_no_delete'")).toBe(4);
    // Fica: o narguilé da casa (livre de novo), categorias, usuários e o histórico de correções.
    expect(await owner.ok('GET', '/api/hookahs')).toEqual([expect.objectContaining({ id: house.id, status: 'available' })]);
    expect((await owner.ok('GET', '/api/categories')).length).toBeGreaterThan(5);
    expect((await owner.ok('GET', '/api/users')).length).toBe(2);
    expect((await owner.ok('GET', '/api/admin/history'))[0]).toMatchObject({ action: 'admin.test_data_reset' });

    // O painel online recebe a exclusão pela fila de sincronização.
    const queued = (entity: string, id: string) => env.s.db.value('SELECT COUNT(*) FROM sync_outbox WHERE entity = ? AND entity_id = ?', entity, id);
    expect(queued('comanda', closedComanda.id)).toBeGreaterThan(0);
    expect(queued('product', beer.id)).toBeGreaterThan(0);

    // Começa do zero: comanda 1 e código de produto 0001.
    expect((await owner.ok('POST', '/api/comandas', { customerName: 'Primeira' })).number).toBe(1);
    expect(await owner.ok('GET', '/api/products/next-code')).toEqual({ code: '0001' });
  });

  it('pode manter o cadastro dos produtos e só zerar o estoque', async () => {
    const { beer } = await testDay();
    await owner.ok('POST', '/api/admin/test-data/reset', { password: OWNER.password, confirm: 'APAGAR', keepProducts: true });
    const p = await owner.ok('GET', `/api/products/${beer.id}`);
    expect(p).toMatchObject({ stockQty: 0, name: 'Heineken long neck' });
    expect(p.presentations[0].priceCents).toBe(1200);
    expect(env.s.db.value('SELECT COUNT(*) FROM option_groups')).toBe(1);
    expect(env.s.db.value('SELECT COUNT(*) FROM stock_movements')).toBe(0);
    expect(env.s.db.value('SELECT COUNT(*) FROM comandas')).toBe(0);
    expect((await owner.ok('GET', '/api/products/next-code')).code).toBe('0002');
  });
});
