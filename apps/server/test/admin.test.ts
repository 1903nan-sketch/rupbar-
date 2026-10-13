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

async function beer(qty = 24) {
  const cat = await category(owner, 'Cervejas');
  const { id } = await owner.ok('POST', '/api/products', {
    name: 'Cerveja long neck', categoryId: cat, measure: 'unit', packageQty: 1000, presentations: [{ name: 'Unidade', priceCents: 1200 }],
  });
  const purchase = await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: id, packages: qty, packageQty: 1000, totalCostCents: qty * 450 }] });
  const pres = (await owner.ok('GET', `/api/products/${id}`)).presentations[0].id as string;
  return { id: id as string, pres, purchaseId: purchase.id as string };
}

const stockOf = async (id: string) => (await owner.ok('GET', `/api/products/${id}`)).stockQty as number;

/** Comanda com 3 cervejas paga em dinheiro e encerrada; caixa fechado. */
async function closedSale() {
  const b = await beer();
  await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 5_000 });
  const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia', cardNumber: 12 });
  await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: b.pres, quantity: 3 }] });
  const pay = await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'cash', amountCents: 3_600, clientRequestId: uuid() });
  await owner.ok('POST', `/api/comandas/${c.id}/close`, { expectedVersion: pay.comanda.version });
  const session = (await owner.ok('GET', '/api/cash/current')).session;
  await owner.ok('POST', '/api/cash/close', { countedCashCents: 8_600 });
  return { b, c, paymentId: pay.id as string, sessionId: session.id as string };
}

describe('conta mestre: editar e excluir qualquer lançamento', () => {
  it('somente o proprietário pode corrigir', async () => {
    const { c, paymentId } = await closedSale();
    const manager = await createStaff(env, owner, 'manager', 'Gerente', 'g@bar.com');
    expect((await manager.fail('POST', `/api/admin/payments/${paymentId}/delete`, { reason: 'teste' })).status).toBe(403);
    expect((await manager.fail('POST', `/api/admin/comandas/${c.id}/delete`, { reason: 'teste' })).status).toBe(403);
    expect((await owner.fail('POST', `/api/admin/payments/${paymentId}/delete`, {})).code).toBe('VALIDATION');
  });

  it('pagamento de comanda e caixa já encerrados: trocar a forma recalcula o caixa; excluir reabre a comanda', async () => {
    const { c, paymentId, sessionId } = await closedSale();
    let s = await owner.ok('GET', `/api/cash/sessions/${sessionId}`);
    expect(s.session).toMatchObject({ expectedCashCents: 8_600, differenceCents: 0 });

    // Era Pix, não dinheiro: o dinheiro esperado cai e aparece a diferença.
    let d = await owner.ok('PUT', `/api/admin/payments/${paymentId}`, { method: 'pix', amountCents: 3_600, reason: 'Cliente pagou no Pix' });
    expect(d.status).toBe('closed');
    expect(d.payments.map((p: { method: string; status: string }) => `${p.method}:${p.status}`)).toEqual(['cash:reversed', 'pix:active']);
    s = await owner.ok('GET', `/api/cash/sessions/${sessionId}`);
    expect(s.session).toMatchObject({ expectedCashCents: 5_000, differenceCents: 3_600 });

    // Excluir o pagamento: a comanda volta a ter saldo e é reaberta (cartão preservado).
    const pix = d.payments.find((p: { status: string }) => p.status === 'active');
    d = await owner.ok('POST', `/api/admin/payments/${pix.id}/delete`, { reason: 'Pix não caiu' });
    expect(d).toMatchObject({ status: 'open', remaining: 3_600, cardNumber: 12 });

    const history = await owner.ok('GET', '/api/admin/history');
    expect(history.map((h: { action: string }) => h.action)).toEqual(['admin.payment_deleted', 'admin.payment_edited']);
  });

  it('itens: preço corrigido no lugar; quantidade corrigida ajusta o estoque; excluir devolve ao estoque', async () => {
    const { b, c } = await closedSale();
    expect(await stockOf(b.id)).toBe(21_000);
    let d = await owner.ok('GET', `/api/comandas/${c.id}`);
    const item = d.items[0];
    d = await owner.ok('PUT', `/api/admin/comanda-items/${item.id}`, { quantity: 3, unitPriceCents: 1_000, reason: 'Preço promocional' });
    // Pago 36,00 > total 30,00: comanda continua encerrada (pago a mais aparece).
    expect(d).toMatchObject({ status: 'closed', total: 3_000, paid: 3_600 });
    d = await owner.ok('PUT', `/api/admin/comanda-items/${item.id}`, { quantity: 4, unitPriceCents: 1_000, reason: 'Foram 4' });
    expect(await stockOf(b.id)).toBe(20_000);
    const active = d.items.filter((i: { status: string }) => i.status === 'active');
    expect(active).toEqual([expect.objectContaining({ quantity: 4, unitPriceCents: 1_000 })]);
    // Total 40,00 > pago 36,00: a comanda é reaberta para cobrar a diferença.
    expect(d).toMatchObject({ status: 'open', total: 4_000, remaining: 400 });
    d = await owner.ok('POST', `/api/admin/comanda-items/${active[0].id}/delete`, { reason: 'Não foi consumido', returnToStock: true });
    expect(await stockOf(b.id)).toBe(24_000);
    expect(d).toMatchObject({ total: 0, paid: 3_600 });
  });

  it('excluir comanda encerrada: estorna pagamentos, devolve estoque e recalcula o caixa', async () => {
    const { b, c, sessionId } = await closedSale();
    const d = await owner.ok('POST', `/api/admin/comandas/${c.id}/delete`, { reason: 'Lançada por engano', returnToStock: true });
    expect(d).toMatchObject({ status: 'canceled', paid: 0 });
    expect(await stockOf(b.id)).toBe(24_000);
    const s = await owner.ok('GET', `/api/cash/sessions/${sessionId}`);
    expect(s.session).toMatchObject({ expectedCashCents: 5_000, differenceCents: 3_600 });
    // O cartão 12 fica livre.
    await owner.ok('POST', '/api/comandas', { cardNumber: 12 });
  });

  it('caixa: sangria editada e excluída, troco inicial corrigido e caixa reaberto', async () => {
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 10_000 });
    const m = await owner.ok('POST', '/api/cash/movements', { type: 'withdrawal', amountCents: 3_000, reason: 'Pagamento do gelo', clientRequestId: uuid() });
    const session = (await owner.ok('GET', '/api/cash/current')).session;
    await owner.ok('PUT', `/api/admin/cash-movements/${m.id}`, { amountCents: 2_000, description: 'Pagamento do gelo', reason: 'Valor digitado errado' });
    let cur = await owner.ok('GET', '/api/cash/current');
    expect(cur.summary.expectedCash).toBe(8_000);
    const edited = cur.movements.find((x: { status: string }) => x.status === 'active');
    await owner.ok('POST', `/api/admin/cash-movements/${edited.id}/delete`, { reason: 'Não houve sangria' });
    cur = await owner.ok('GET', '/api/cash/current');
    expect(cur.summary.expectedCash).toBe(10_000);
    await owner.ok('PUT', `/api/admin/cash-sessions/${session.id}`, { openingBalanceCents: 12_000, reason: 'Troco contado errado' });
    expect((await owner.ok('GET', '/api/cash/current')).summary.expectedCash).toBe(12_000);
    await owner.ok('POST', '/api/cash/close', { countedCashCents: 12_000 });
    await owner.ok('POST', `/api/admin/cash-sessions/${session.id}/reopen`, { reason: 'Faltou lançar uma venda' });
    expect((await owner.ok('GET', '/api/cash/current')).open).toBe(true);
  });

  it('estoque: excluir entrada, desfazer ajuste e excluir perda', async () => {
    const b = await beer(24);
    await owner.ok('POST', '/api/stock/adjustments', { productId: b.id, countedQty: 20_000, reason: 'Contagem' });
    expect(await stockOf(b.id)).toBe(20_000);
    const mv = (await owner.ok('GET', `/api/stock/movements?productId=${b.id}`)).find((m: { type: string }) => m.type === 'adjustment');
    await owner.ok('POST', `/api/admin/stock-movements/${mv.id}/reverse`, { reason: 'Contagem errada' });
    expect(await stockOf(b.id)).toBe(24_000);
    expect((await owner.fail('POST', `/api/admin/stock-movements/${mv.id}/reverse`, { reason: 'de novo' })).code).toBe('ALREADY_REVERSED');

    const loss = await owner.ok('POST', '/api/losses', { productId: b.id, qty: 2_000, unit: 'un', reason: 'broken', clientRequestId: uuid() });
    expect(await stockOf(b.id)).toBe(22_000);
    await owner.ok('POST', `/api/admin/losses/${loss.id}/delete`, { reason: 'Não quebrou' });
    expect(await stockOf(b.id)).toBe(24_000);

    await owner.ok('POST', `/api/admin/purchases/${b.purchaseId}/cancel`, { reason: 'Nota lançada em duplicidade' });
    expect(await stockOf(b.id)).toBe(0);
    expect((await owner.fail('POST', `/api/admin/purchases/${b.purchaseId}/cancel`, { reason: 'de novo' })).code).toBe('ALREADY_CANCELED');
  });
});
