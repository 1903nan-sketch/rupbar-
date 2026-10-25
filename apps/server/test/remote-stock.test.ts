import type { RemoteCommand } from '@rupbar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { category, Client, createEnv, setupEstablishment, uuid, type TestEnv } from './helpers';

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

const send = (type: RemoteCommand['type'], payload: Record<string, unknown>) =>
  env.s.sync.applyCommand({ id: uuid(), type, payload: { ...payload, registeredByName: 'Marina (painel online)' }, createdAt: new Date().toISOString(), createdBy: null });

/** Cerveja em fardo de 12, 24 latas a R$ 4,00 (mínimo 12). */
async function beer() {
  const p = await owner.ok('POST', '/api/products', {
    name: 'Heineken lata', categoryId: await category(owner, 'Cervejas'), measure: 'unit', packageQty: 12_000, packageLabel: 'fardo', unitLabel: 'lata',
    minStock: 12_000, presentations: [{ name: 'Unidade', priceCents: 1_000 }, { name: 'Balde 5', priceCents: 4_500, components: [{ productId: null, qty: 5_000 }] }],
    initialStock: { qty: 24_000, totalCostCents: 9_600 },
  });
  return owner.ok('GET', `/api/products/${p.id}`);
}

describe('estoque e produtos pelo painel online', () => {
  it('entrada: soma ao saldo, refaz o custo médio e fica no histórico de entradas', async () => {
    const p = await beer();
    const r = await send('stock.entry', { productId: p.id, qty: 24_000, totalCostCents: 12_000, invoiceNumber: '123' });
    expect(r).toMatchObject({ status: 'applied', message: 'Entrada de 24 un de Heineken lata (R$ 120,00). Saldo: 48 un.' });
    const after = await owner.ok('GET', `/api/products/${p.id}`);
    expect(after.stockQty).toBe(48_000);
    expect(after.unitCostE4).toBe(4_500_000); // (96 + 120) / 48 latas = R$ 4,50
    const purchases = await owner.ok('GET', '/api/stock/purchases');
    expect(purchases.find((x: { invoice_number: string | null }) => x.invoice_number === '123')).toMatchObject({ notes: 'Pelo painel online', total_cents: 12_000 });
    expect((await send('stock.entry', { productId: p.id, qty: 0, totalCostCents: 100 })).status).toBe('rejected');
  });

  it('corrigir saldo (contagem) e estoque mínimo abrem e resolvem o alerta', async () => {
    const p = await beer();
    const adj = await send('stock.adjust', { productId: p.id, countedQty: 10_000, reason: 'Contagem do painel' });
    expect(adj).toMatchObject({ status: 'applied', message: 'Saldo de Heineken lata corrigido: 24 un → 10 un.' });
    expect((await owner.ok('GET', `/api/products/${p.id}`)).level).toBe('low');
    expect(env.s.db.value("SELECT COUNT(*) FROM stock_alerts WHERE product_id = ? AND status = 'open'", p.id)).toBe(1);
    // Mínimo menor: deixa de estar baixo e o alerta fecha.
    const min = await send('product.update', { productId: p.id, minStock: 6_000 });
    expect(min).toMatchObject({ status: 'applied', message: 'Heineken lata: mínimo 12 un → 6 un.' });
    expect(env.s.db.value("SELECT COUNT(*) FROM stock_alerts WHERE product_id = ? AND status = 'open'", p.id)).toBe(0);
    expect((await send('stock.adjust', { productId: p.id, countedQty: 5_000, reason: 'x' })).status).toBe('rejected'); // motivo curto
  });

  it('preços: muda só as apresentações informadas; de outro produto ou sem estoque é recusado', async () => {
    const p = await beer();
    const [unidade, balde] = p.presentations;
    const r = await send('product.update', { productId: p.id, prices: [{ presentationId: unidade.id, priceCents: 1_200 }, { presentationId: balde.id, priceCents: 4_500 }] });
    expect(r).toMatchObject({ status: 'applied', message: 'Heineken lata: Unidade R$ 10,00 → R$ 12,00.' });
    const after = await owner.ok('GET', `/api/products/${p.id}`);
    expect(after.presentations.map((x: { priceCents: number }) => x.priceCents)).toEqual([1_200, 4_500]);
    expect(env.s.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'products.quick_updated'")).toBe(1);

    const porcao = await owner.ok('POST', '/api/products', {
      name: 'Porção de batata', categoryId: await category(owner, 'Porções'), measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 2_500 }],
    });
    const otherPres = (await owner.ok('GET', `/api/products/${porcao.id}`)).presentations[0].id;
    expect(await send('product.update', { productId: p.id, prices: [{ presentationId: otherPres, priceCents: 1 }] })).toMatchObject({ status: 'rejected', message: 'Apresentação não encontrada em Heineken lata.' });
    expect(await send('product.update', { productId: porcao.id, minStock: 1_000 })).toMatchObject({ status: 'rejected', message: 'Porção de batata não tem controle de estoque.' });
    expect(await send('product.update', { productId: porcao.id, prices: [{ presentationId: otherPres, priceCents: 2_800 }] })).toMatchObject({ status: 'applied', message: 'Porção de batata: Porção R$ 25,00 → R$ 28,00.' });
    expect((await send('product.update', { productId: p.id })).status).toBe('rejected'); // nada para alterar
  });
});
