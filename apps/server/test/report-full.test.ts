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

const HOUR = 3_600_000;

describe('relatório completo (venda do dia)', () => {
  it('soma o dia do bar das 05:00 às 05:00, com recebimentos, descontos, cancelamentos, caixa e produtos', async () => {
    // 14/03 às 19:00 em Brasília.
    const cat = await category(owner, 'Cervejas');
    const p = await owner.ok('POST', '/api/products', {
      name: 'Heineken long neck', categoryId: cat, measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 1200 }],
      initialStock: { qty: 48_000, totalCostCents: 24_000 },
    });
    const pres = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id;
    const davi = await createStaff(env, owner, 'manager', 'Davi', 'davi@bar.com');
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 10_000 });

    // Comanda da Lia: 10 cervejas (Davi lança), 1 cancelada, desconto de R$ 15, paga em pix e dinheiro.
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia', cardNumber: 14 });
    await davi.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 10 }] });
    await davi.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
    const wrong = (await owner.ok('GET', `/api/comandas/${c.id}`)).items.find((i: { quantity: number }) => i.quantity === 1);
    await owner.ok('POST', `/api/comanda-items/${wrong.id}/cancel`, { reason: 'Lançado errado', returnToStock: true });
    let v = (await owner.ok('GET', `/api/comandas/${c.id}`)).version;
    await owner.ok('POST', `/api/comandas/${c.id}/discount`, { discountCents: 1_500, reason: 'Cerveja quente', expectedVersion: v });

    // Depois da meia-noite ainda é o dia 14 (01:00 de 15/03).
    env.clock.advance(6 * HOUR);
    await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'pix', amountCents: 5_000, clientRequestId: uuid() });
    await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'cash', amountCents: 5_500, clientRequestId: uuid() });
    v = (await owner.ok('GET', `/api/comandas/${c.id}`)).version;
    await owner.ok('POST', `/api/comandas/${c.id}/close`, { expectedVersion: v });
    await owner.ok('POST', '/api/cash/movements', { type: 'withdrawal', amountCents: 2_000, reason: 'Gelo', clientRequestId: uuid() });

    // Dia seguinte (15/03 às 07:00): não entra no dia 14.
    env.clock.advance(6 * HOUR);
    const other = await owner.ok('POST', '/api/comandas', { customerName: 'Rita' });
    await owner.ok('POST', '/api/orders', { comandaId: other.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });

    const r = await owner.ok('GET', '/api/reports/full?de=2026-03-14');
    expect(r).toMatchObject({ de: '2026-03-14', ate: '2026-03-14', from: '2026-03-14T08:00:00.000Z', to: '2026-03-15T08:00:00.000Z' });
    expect(r.summary).toMatchObject({
      grossCents: 12_000, discountsCents: 1_500, serviceFeeCents: 0, receivedCents: 10_500, costCents: 5_000, itemsSold: 10,
      closedComandas: 1, quickSales: 0, canceledCents: 1_200, stillOpen: 0,
    });
    expect(r.payments).toEqual([{ method: 'cash', count: 1, totalCents: 5_500 }, { method: 'pix', count: 1, totalCents: 5_000 }]);
    expect(r.products).toEqual([{ name: 'Heineken long neck', presentation: 'Unidade', qty: 10, totalCents: 12_000, costCents: 5_000 }]);
    expect(r.byWaiter).toEqual([{ name: 'Davi', orders: 1, totalCents: 12_000 }]);
    expect(r.byHour).toEqual([{ hour: 19, totalCents: 12_000 }]);
    expect(r.discounts).toEqual([expect.objectContaining({ comanda: 'Comanda 14', customer: 'Lia', reason: 'Cerveja quente', discountCents: 1_500, closedBy: 'Marina Souza' })]);
    expect(r.cancellations).toEqual([expect.objectContaining({ product: 'Heineken long neck', qty: 1, totalCents: 1_200, reason: 'Lançado errado', by: 'Marina Souza' })]);
    // Caixa ainda aberto: esperado = troco + dinheiro − sangria.
    expect(r.cashSessions).toEqual([expect.objectContaining({ number: 1, status: 'open', openingCents: 10_000, expectedCents: 13_500, countedCents: null })]);
    expect(r.cashMovements).toEqual([expect.objectContaining({ type: 'withdrawal', amountCents: 2_000, reason: 'Gelo' })]);

    // Dia 15: só a comanda da Rita, ainda aberta.
    const next = await owner.ok('GET', '/api/reports/full?de=2026-03-15');
    expect(next.summary).toMatchObject({ grossCents: 1_200, receivedCents: 0, stillOpen: 1, stillOpenCents: 1_200, closedComandas: 0 });
    // Período (14 e 15).
    const both = await owner.ok('GET', '/api/reports/full?de=2026-03-14&ate=2026-03-15');
    expect(both.byDay).toEqual([{ day: '2026-03-14', totalCents: 12_000, costCents: 5_000 }, { day: '2026-03-15', totalCents: 1_200, costCents: 500 }]);

    // PDF para salvar.
    const pdf = await owner.req('GET', '/api/reports/full.pdf?de=2026-03-14');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="vendas-2026-03-14.pdf"');
    expect(pdf.rawPayload.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.rawPayload.toString('latin1')).toContain('(Cerveja quente) Tj');

    // Impressora do caixa.
    expect((await owner.fail('POST', '/api/reports/full/print', { de: '2026-03-14' })).code).toBe('NO_RECEIPT_PRINTER');
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'network', host: '192.168.0.210', printReceipts: true, paper: 80 });
    const printed = await owner.ok('POST', '/api/reports/full/print', { de: '2026-03-14' });
    expect(printed.jobs).toHaveLength(1);
    expect(env.s.db.value('SELECT title FROM print_jobs WHERE id = ?', printed.jobs[0])).toBe('Venda do dia Sábado, 14/03/2026');
  });

  it('só quem vê o financeiro', async () => {
    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    expect((await waiter.fail('GET', '/api/reports/full?de=2026-03-14')).status).toBe(403);
    expect((await waiter.req('GET', '/api/reports/full.pdf?de=2026-03-14')).statusCode).toBe(403);
    expect((await owner.fail('GET', '/api/reports/full?de=14-03-2026')).status).toBe(400);
    expect((await owner.fail('GET', '/api/reports/full?de=2026-02-30')).status).toBe(400);
  });
});
