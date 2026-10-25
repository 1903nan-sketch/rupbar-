import type { RemoteCommand } from '@rupbar/core';
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

const send = (type: RemoteCommand['type'], payload: Record<string, unknown>) =>
  env.s.sync.applyCommand({ id: uuid(), type, payload: { ...payload, registeredByName: 'Marina (painel online)' }, createdAt: new Date().toISOString(), createdBy: null });

async function comandaWithBeers(qty = 5, cardNumber = 14): Promise<{ id: string; pres: string }> {
  const p = await owner.ok('POST', '/api/products', {
    name: `Heineken ${cardNumber}`, categoryId: await category(owner, 'Cervejas'), measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 1_200 }],
    initialStock: { qty: 48_000, totalCostCents: 24_000 },
  });
  const pres = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id;
  const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia', cardNumber });
  await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: qty }] });
  return { id: c.id, pres };
}

describe('encerrar comanda pelo painel online', () => {
  it('recebe o que falta (em uma ou mais formas) e encerra de uma vez', async () => {
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    const { id } = await comandaWithBeers(5); // R$ 60
    const r = await send('comanda.close', { comandaId: id, payments: [{ method: 'pix', amountCents: 4_000 }, { method: 'cash', amountCents: 2_000 }] });
    expect(r).toMatchObject({ status: 'applied', message: 'Comanda 14 encerrada (Pix R$ 40,00 + Dinheiro R$ 20,00). Total R$ 60,00.' });
    const c = await owner.ok('GET', `/api/comandas/${id}`);
    expect(c).toMatchObject({ status: 'closed', paid: 6_000, remaining: 0 });
    expect(c.payments.map((p: { method: string; amount_cents: number }) => [p.method, p.amount_cents])).toEqual([['pix', 4_000], ['cash', 2_000]]);
    // O dinheiro entra no caixa aberto.
    expect((await owner.ok('GET', '/api/cash/current')).summary).toMatchObject({ expectedCash: 2_000 });
    expect(env.s.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'comandas.closed'")).toBe(1);
    // De novo: já encerrada.
    expect(await send('comanda.close', { comandaId: id, payments: [] })).toMatchObject({ status: 'rejected', message: 'A Comanda 14 já foi encerrada.' });
  });

  it('se a comanda mudou ou o caixa está fechado, nada fica pela metade', async () => {
    const { id, pres } = await comandaWithBeers(5); // R$ 60
    // Caixa fechado: dinheiro não entra; nem o Pix da mesma ação fica registrado.
    const closed = await send('comanda.close', { comandaId: id, payments: [{ method: 'pix', amountCents: 4_000 }, { method: 'cash', amountCents: 2_000 }] });
    expect(closed).toMatchObject({ status: 'rejected', message: 'Abra o caixa antes de receber pagamentos.' });
    expect(await owner.ok('GET', `/api/comandas/${id}`)).toMatchObject({ status: 'open', paid: 0 });

    // Lançaram mais uma cerveja depois que o proprietário viu R$ 60.
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    await owner.ok('POST', '/api/orders', { comandaId: id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
    const changed = await send('comanda.close', { comandaId: id, payments: [{ method: 'pix', amountCents: 6_000 }] });
    expect(changed).toMatchObject({ status: 'conflict', message: 'A Comanda 14 mudou: falta R$ 72,00, não R$ 60,00. Confira e envie de novo.' });
    expect(await owner.ok('GET', `/api/comandas/${id}`)).toMatchObject({ status: 'open', paid: 0 });

    // Parte já paga no PC: o painel manda só o que falta.
    await owner.ok('POST', '/api/payments', { comandaId: id, method: 'credit', amountCents: 5_000, clientRequestId: uuid() });
    expect(await send('comanda.close', { comandaId: id, payments: [{ method: 'pix', amountCents: 2_200 }] })).toMatchObject({ status: 'applied' });
    expect(await owner.ok('GET', `/api/comandas/${id}`)).toMatchObject({ status: 'closed', paid: 7_200 });
  });

  it('já paga ou de funcionário: só encerra; comando inválido é recusado', async () => {
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    const { id } = await comandaWithBeers(1); // R$ 12
    await owner.ok('POST', '/api/payments', { comandaId: id, method: 'pix', amountCents: 1_200, clientRequestId: uuid() });
    expect(await send('comanda.close', { comandaId: id, payments: [] })).toMatchObject({ status: 'applied', message: 'Comanda 14 encerrada. Total R$ 12,00.' });

    const davi = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const users = await owner.ok('GET', '/api/users');
    const staff = await owner.ok('POST', '/api/comandas', { kind: 'staff', staffUserId: users.find((u: { name: string }) => u.name === 'Davi').id });
    expect(await send('comanda.close', { comandaId: staff.id, payments: [] })).toMatchObject({ status: 'applied' });
    expect((await davi.ok('GET', `/api/comandas/${staff.id}`)).status).toBe('closed');

    expect(await send('comanda.close', { comandaId: uuid(), payments: [] })).toMatchObject({ status: 'rejected' });
    expect(await send('comanda.close', { comandaId: id, payments: [{ method: 'bitcoin', amountCents: 100 }] })).toMatchObject({ status: 'rejected' });
  });
});
