import type { RemoteCommand } from '@rupbar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, setupEstablishment, uuid, type Client, type TestEnv } from './helpers';

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

const send = (type: RemoteCommand['type'], payload: Record<string, unknown>, id = uuid()) =>
  env.s.sync.applyCommand({ id, type, payload: { ...payload, registeredByName: 'Marina (painel online)' }, createdAt: new Date().toISOString(), createdBy: null });

describe('sangria e suprimento pelo painel online', () => {
  it('registra no caixa aberto e entra no dinheiro esperado da gaveta', async () => {
    expect(await send('cash.movement', { type: 'supply', amountCents: 5_000, reason: 'Troco extra' })).toMatchObject({
      status: 'rejected', message: 'Abra o caixa antes de registrar movimentações.',
    });
    expect((await send('cash.open', { openingBalanceCents: 10_000 })).status).toBe('applied');
    expect(await send('cash.movement', { type: 'supply', amountCents: 5_000, reason: 'Troco extra' })).toMatchObject({
      status: 'applied', message: 'Suprimento de R$ 50,00 registrado (Troco extra).',
    });
    const id = uuid();
    expect(await send('cash.movement', { type: 'withdrawal', amountCents: 3_000, reason: 'Pagamento do gelo' }, id)).toMatchObject({ status: 'applied' });
    // O mesmo comando chegando duas vezes não tira duas vezes.
    expect((await send('cash.movement', { type: 'withdrawal', amountCents: 3_000, reason: 'Pagamento do gelo' }, id)).status).toBe('applied');
    expect((await owner.ok('GET', '/api/cash/current')).summary).toMatchObject({ supplies: 5_000, withdrawals: 3_000, expectedCash: 12_000 });
  });

  it('sangria maior que o dinheiro da gaveta e dados inválidos são recusados', async () => {
    await send('cash.open', { openingBalanceCents: 2_000 });
    expect((await send('cash.movement', { type: 'withdrawal', amountCents: 9_000, reason: 'Banco' })).message).toBe('O valor da sangria é maior que o dinheiro esperado no caixa.');
    expect((await send('cash.movement', { type: 'withdrawal', amountCents: 0, reason: 'Banco' })).status).toBe('rejected');
    expect((await send('cash.movement', { type: 'withdrawal', amountCents: 100, reason: '' })).status).toBe('rejected');
    expect((await owner.ok('GET', '/api/cash/current')).summary).toMatchObject({ withdrawals: 0, expectedCash: 2_000 });
  });
});
