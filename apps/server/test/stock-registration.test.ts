import { afterEach, describe, expect, it } from 'vitest';
import { category, createEnv, createStaff, setupEstablishment, type TestEnv } from './helpers';

let env: TestEnv;
afterEach(async () => { await env.app.close(); env.s.close(); });

describe('cadastro com estoque inicial', () => {
  it('cadastra embalagens, custo médio e histórico de entrada na mesma transação', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const product = await owner.ok('POST', '/api/products', {
      name: 'Whisky teste', categoryId: await category(owner, 'Destilados'), measure: 'volume', packageQty: 1_000_000,
      presentations: [{ name: 'Dose 50 ml', priceCents: 2990, components: [{ productId: null, qty: 50_000 }] }],
      initialStock: { packages: 2, totalCostCents: 30_000 },
    });
    const saved = await owner.ok('GET', `/api/products/${product.id}`);
    expect(saved).toMatchObject({ stockQty: 2_000_000, unitCostE4: 150_000 });
    expect(saved.presentations[0].available).toBe(40);
    expect((await owner.ok('GET', '/api/stock/purchases'))[0]).toMatchObject({ total_cents: 30_000, notes: 'Estoque inicial no cadastro do produto' });
    const moves = await owner.ok('GET', `/api/stock/movements?productId=${product.id}`);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: 'purchase', delta: 2_000_000, balance_after: 2_000_000 });
  });

  it('exige permissão de entrada e não deixa um produto parcial quando a entrada falha', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const roles = await owner.ok('GET', '/api/roles');
    const managerRole = roles.find((r: { key: string }) => r.key === 'manager');
    await owner.ok('PUT', `/api/roles/${managerRole.id}`, { name: managerRole.name, permissions: ['products.manage', 'products.view'] });
    const manager = await createStaff(env, owner, 'manager', 'Gerente', 'g@bar.com');
    const payload = { name: 'Produto sem permissão', categoryId: await category(owner, 'Cervejas'), measure: 'unit', initialStock: { packages: 12, totalCostCents: 6000 } };
    expect((await manager.fail('POST', '/api/products', payload)).status).toBe(403);
    expect(env.s.db.value('SELECT COUNT(*) FROM products')).toBe(0);
    expect((await owner.fail('POST', '/api/products', { ...payload, initialStock: { packages: 0.000001, totalCostCents: 100 } })).status).toBe(400);
    expect(env.s.db.value('SELECT COUNT(*) FROM products')).toBe(0);
    const missingSupplier = '00000000-0000-4000-8000-000000000000';
    expect((await owner.fail('POST', '/api/products', { ...payload, supplierId: missingSupplier })).status).toBeGreaterThanOrEqual(400);
    expect(env.s.db.value('SELECT COUNT(*) FROM products')).toBe(0);
    expect(env.s.db.value('SELECT COUNT(*) FROM purchases')).toBe(0);
    expect(env.s.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'products.created'")).toBe(0);
  });

  it('recusa saldo inicial em atualização e permite cadastrar ingrediente sem preço de venda', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const payload = { name: 'Ingrediente teste', categoryId: await category(owner, 'Destilados'), measure: 'mass', packageQty: 50_000, menuVisible: false, presentations: [] };
    const product = await owner.ok('POST', '/api/products', { ...payload, initialStock: { packages: 4, totalCostCents: 4000 } });
    expect((await owner.ok('GET', `/api/products/${product.id}`)).stockQty).toBe(200_000);
    expect((await owner.fail('PUT', `/api/products/${product.id}`, { ...payload, initialStock: { packages: 1, totalCostCents: 1000 } })).status).toBe(400);
    expect((await owner.ok('GET', `/api/products/${product.id}`)).stockQty).toBe(200_000);
    expect((await owner.ok('GET', '/api/stock/purchases'))).toHaveLength(1);
  });
});
