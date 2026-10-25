import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const stockOf = (id: string) => Number(env.s.db.value('SELECT stock_qty FROM products WHERE id = ?', id));

/** Insumo: estoque em g, fora do cardápio, sem preço. */
async function insumo(name: string, packageQty: number, qty: number, totalCostCents: number, minStock = 0): Promise<string> {
  const r = await owner.ok('POST', '/api/products', {
    name, categoryId: await category(owner, 'Insumos'), measure: 'mass', packageQty, packageLabel: 'pacote', stockTracked: true, minStock,
    menuVisible: false, presentations: [], initialStock: { qty, totalCostCents },
  });
  return r.id;
}

/** Prato sem estoque próprio: a venda baixa os insumos da ficha. */
async function prato(name: string, priceCents: number, components: { productId: string; qty: number }[]): Promise<{ id: string; pres: string }> {
  const r = await owner.ok('POST', '/api/products', {
    name, categoryId: await category(owner, 'Porções'), measure: 'unit', stockTracked: false, menuVisible: true,
    presentations: [{ name, priceCents, components }],
  });
  return { id: r.id, pres: (await owner.ok('GET', `/api/products/${r.id}`)).presentations[0].id };
}

describe('fichas técnicas', () => {
  it('um insumo em vários pratos: a venda baixa 200 g e 300 g dos 5 kg de batata, numa transação só', async () => {
    // 5 kg de batata a R$ 12/kg (mínimo 1 kg) e 1 kg de cheddar a R$ 40/kg.
    const batata = await insumo('Batata congelada', 2_500_000, 5_000_000, 6_000, 1_000_000);
    const cheddar = await insumo('Cheddar', 1_000_000, 1_000_000, 4_000);
    const simples = await prato('Porção de batata', 2_500, [{ productId: batata, qty: 200_000 }]);
    const completa = await prato('Batata com cheddar', 3_800, [{ productId: batata, qty: 300_000 }, { productId: cheddar, qty: 50_000 }]);

    // Custo do prato = soma dos insumos; quantos dá para fazer com o estoque.
    const view = (id: string) => owner.ok('GET', `/api/products/${id}`).then((p) => p.presentations[0]);
    expect(await view(simples.id)).toMatchObject({ costCents: 240, available: 25 });
    expect(await view(completa.id)).toMatchObject({ costCents: 560, available: 16 });
    expect((await owner.ok('GET', `/api/products/${simples.id}`)).stockTracked).toBe(false);

    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    const order = (items: { presentationId: string; quantity: number }[]) => owner.req('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items });
    expect((await order([{ presentationId: simples.pres, quantity: 2 }, { presentationId: completa.pres, quantity: 1 }])).statusCode).toBe(200);
    expect(stockOf(batata)).toBe(4_300_000); // 5.000 − 2×200 − 300
    expect(stockOf(cheddar)).toBe(950_000);
    const moves = env.s.db.all<{ product_id: string; delta: number }>("SELECT product_id, delta FROM stock_movements WHERE type = 'sale' ORDER BY delta");
    expect(moves).toEqual(expect.arrayContaining([
      { product_id: batata, delta: -400_000 }, { product_id: batata, delta: -300_000 }, { product_id: cheddar, delta: -50_000 },
    ]));
    // O prato não tem estoque próprio: nenhuma movimentação dele.
    expect(env.s.db.value('SELECT COUNT(*) FROM stock_movements WHERE product_id IN (?, ?)', simples.id, completa.id)).toBe(0);

    // Pedido que falha no meio não baixa nada (tudo ou nada).
    const failed = await order([{ presentationId: simples.pres, quantity: 1 }, { presentationId: uuid(), quantity: 1 }]);
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(stockOf(batata)).toBe(4_300_000);

    // Abaixo do mínimo (1 kg): abre o alerta do insumo.
    expect(env.s.db.value("SELECT COUNT(*) FROM stock_alerts WHERE product_id = ? AND status = 'open'", batata)).toBe(0);
    await order([{ presentationId: completa.pres, quantity: 11 }]);
    expect(stockOf(batata)).toBe(1_000_000);
    expect((await owner.ok('GET', '/api/stock/alerts')).some((a: { product_id?: string; productId?: string }) => (a.product_id ?? a.productId) === batata)).toBe(true);
    expect((await owner.ok('GET', `/api/products/${batata}`)).level).toBe('low');

    // Cancelar devolvendo ao estoque volta os insumos.
    const item = (await owner.ok('GET', `/api/comandas/${c.id}`)).items.find((i: { quantity: number }) => i.quantity === 11);
    await owner.ok('POST', `/api/comanda-items/${item.id}/cancel`, { reason: 'Lançado errado', returnToStock: true });
    expect(stockOf(batata)).toBe(4_300_000);
    expect(stockOf(cheddar)).toBe(950_000);
    expect(env.s.db.value("SELECT COUNT(*) FROM stock_alerts WHERE product_id = ? AND status = 'open'", batata)).toBe(0);
  });

  it('editar a ficha de um prato: insumo repetido soma, preço junto, só quem cadastra produtos', async () => {
    const batata = await insumo('Batata congelada', 1_000_000, 5_000_000, 6_000);
    const simples = await prato('Porção de batata', 2_500, [{ productId: batata, qty: 200_000 }]);
    env.s.ctx.setMeta('sync_enabled', '1'); // PC conectado à nuvem
    await owner.ok('PUT', `/api/presentations/${simples.pres}/recipe`, {
      priceCents: 2_700, components: [{ productId: batata, qty: 250_000 }, { productId: batata, qty: 50_000 }],
    });
    const pres = (await owner.ok('GET', `/api/products/${simples.id}`)).presentations[0];
    expect(pres).toMatchObject({ priceCents: 2_700, costCents: 360, components: [expect.objectContaining({ productId: batata, qty: 300_000 })] });

    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Rita' });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: simples.pres, quantity: 1 }] });
    expect(stockOf(batata)).toBe(4_700_000);
    expect(env.s.db.value("SELECT action FROM audit_log WHERE action = 'products.recipe_updated'")).toBe('products.recipe_updated');
    // A ficha nova vai para a nuvem (fila de sincronização).
    expect(env.s.db.value("SELECT COUNT(*) FROM sync_outbox WHERE entity = 'presentation' AND entity_id = ?", simples.pres)).toBeGreaterThan(0);

    // Ficha vazia, insumo sem estoque controlado, garçom sem permissão.
    expect((await owner.fail('PUT', `/api/presentations/${simples.pres}/recipe`, { components: [] })).status).toBe(400);
    const outro = await prato('Batata dupla', 4_000, [{ productId: batata, qty: 400_000 }]);
    expect((await owner.fail('PUT', `/api/presentations/${outro.pres}/recipe`, { components: [{ productId: simples.id, qty: 1_000 }] })).code).toBe('INGREDIENT_NOT_TRACKED');
    expect((await owner.fail('PUT', `/api/presentations/${uuid()}/recipe`, { components: [{ productId: batata, qty: 1_000 }] })).status).toBe(404);
    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    expect((await waiter.fail('PUT', `/api/presentations/${simples.pres}/recipe`, { components: [{ productId: batata, qty: 1_000 }] })).status).toBe(403);
    // Garçom não vê custo.
    expect((await waiter.ok('GET', `/api/products/${simples.id}`)).presentations[0].costCents).toBeNull();
  });
});
