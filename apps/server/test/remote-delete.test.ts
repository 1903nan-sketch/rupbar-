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

const stockOf = (id: string) => Number(env.s.db.value('SELECT stock_qty FROM products WHERE id = ?', id));
const itemStatus = (id: string) => String(env.s.db.value('SELECT status FROM comanda_items WHERE id = ?', id));

async function comandaWithBeers(qty = 3): Promise<{ comandaId: string; productId: string; items: { id: string }[] }> {
  const p = await owner.ok('POST', '/api/products', {
    name: 'Heineken', categoryId: await category(owner, 'Cervejas'), measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 1_200 }],
    initialStock: { qty: 48_000, totalCostCents: 24_000 },
  });
  const pres = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id;
  const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
  for (let i = 0; i < qty; i++) await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
  const items = (await owner.ok('GET', `/api/comandas/${c.id}`)).items;
  return { comandaId: c.id, productId: p.id, items };
}

describe('apagar item da comanda pela Lixeira (painel online)', () => {
  it('senha certa: apaga sem cobrar; cortesia mantém a baixa, engano devolve ao estoque; tudo fica registrado', async () => {
    const { comandaId, productId, items } = await comandaWithBeers(3);
    expect(stockOf(productId)).toBe(45_000); // 48 − 3 vendidas

    // Consumo/cortesia (a bebida da cantora): sai da conta, estoque continua baixado.
    const cortesia = await send('comanda_item.cancel', { itemId: items[0]!.id, reason: 'Cortesia da casa (show)', returnToStock: false, pin: '354500' });
    expect(cortesia).toMatchObject({ status: 'applied', message: 'Item apagado — consumo/cortesia (estoque mantido baixado).' });
    expect(itemStatus(items[0]!.id)).toBe('canceled');
    expect(stockOf(productId)).toBe(45_000); // continua baixado

    // Engano: devolve ao estoque.
    const engano = await send('comanda_item.cancel', { itemId: items[1]!.id, reason: 'Lançado errado', returnToStock: true, pin: '354500' });
    expect(engano).toMatchObject({ status: 'applied', message: 'Item tirado da comanda (estoque devolvido).' });
    expect(stockOf(productId)).toBe(46_000); // voltou 1

    // Fica registrado: comanda mostra o item como cancelado, com motivo e quem.
    const detail = await owner.ok('GET', `/api/comandas/${comandaId}`);
    const canceled = detail.items.filter((i: { status: string }) => i.status === 'canceled');
    expect(canceled).toHaveLength(2);
    expect(canceled.map((i: { cancelReason: string }) => i.cancelReason).sort()).toEqual(['Cortesia da casa (show)', 'Lançado errado']);
    // Conta cobra só o item que restou.
    expect(detail.total).toBe(1_200);
    // Auditoria registra os dois cancelamentos (nada some).
    expect(env.s.db.value("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'comandas.item%' OR action LIKE '%cancel%'")).toBeGreaterThanOrEqual(2);
  });

  it('senha errada não mexe em nada', async () => {
    const { productId, items } = await comandaWithBeers(2);
    const r = await send('comanda_item.cancel', { itemId: items[0]!.id, reason: 'Cortesia', returnToStock: false, pin: '000000' });
    expect(r).toMatchObject({ status: 'rejected', message: 'Senha da lixeira incorreta.' });
    expect(itemStatus(items[0]!.id)).toBe('active');
    expect(stockOf(productId)).toBe(46_000);
  });

  it('a senha da Lixeira é configurável nas opções de operação', async () => {
    await owner.ok('PUT', '/api/settings/operation', { deletePin: '778899' });
    expect((await owner.ok('GET', '/api/settings/operation')).deletePin).toBe('778899');
    const { items } = await comandaWithBeers(1);
    expect((await send('comanda_item.cancel', { itemId: items[0]!.id, reason: 'Cortesia', returnToStock: false, pin: '354500' })).status).toBe('rejected');
    expect((await send('comanda_item.cancel', { itemId: items[0]!.id, reason: 'Cortesia', returnToStock: false, pin: '778899' })).status).toBe('applied');
    // Senha curta demais é recusada.
    expect((await owner.fail('PUT', '/api/settings/operation', { deletePin: '12' })).status).toBe(400);
  });
});
