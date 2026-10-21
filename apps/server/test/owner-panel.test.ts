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

/** Comando como o painel online envia (o PC aplica uma única vez). */
const send = (type: RemoteCommand['type'], payload: Record<string, unknown>, id = uuid()) =>
  env.s.sync.applyCommand({ id, type, payload: { ...payload, registeredByName: 'Marina (painel online)' }, createdAt: new Date().toISOString(), createdBy: null });

describe('painel online: comandos que o PC aplica', () => {
  it('abre comanda, lança itens, tira item e abre/fecha o caixa', async () => {
    const beers = await category(owner, 'Cervejas');
    const beer = await owner.ok('POST', '/api/products', {
      name: 'Heineken long neck', categoryId: beers, measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 1200 }],
      initialStock: { qty: 24_000, totalCostCents: 12_000 },
    });
    const pres = (await owner.ok('GET', `/api/products/${beer.id}`)).presentations[0].id;

    const opened = await send('cash.open', { openingBalanceCents: 10_000 });
    expect(opened).toMatchObject({ status: 'applied', message: 'Caixa 1 aberto.' });
    expect((await send('cash.open', { openingBalanceCents: 0 })).message).toMatch(/Já existe um caixa aberto/);

    const openCmd = uuid();
    const c = await send('comanda.open', { customerName: 'Lia', cardNumber: 12, table: '4' }, openCmd);
    expect(c).toMatchObject({ status: 'applied', message: 'Comanda 12 aberta.' });
    const comandaId = c.result!.comandaId as string;
    // Reentrega do mesmo comando não abre outra comanda.
    expect((await send('comanda.open', { customerName: 'Lia', cardNumber: 12 }, openCmd)).status).toBe('applied');
    expect(env.s.db.value("SELECT COUNT(*) FROM comandas WHERE kind = 'regular'")).toBe(1);

    const order = await send('order.create', { comandaId, items: [{ presentationId: pres, quantity: 3 }] });
    expect(order).toMatchObject({ status: 'applied', message: expect.stringMatching(/^Pedido \d+ lançado na comanda 12\.$/) });
    expect((await owner.ok('GET', `/api/products/${beer.id}`)).stockQty).toBe(21_000);
    let d = await owner.ok('GET', `/api/comandas/${comandaId}`);
    expect(d.items).toHaveLength(1);
    expect(d.total).toBe(3_600);

    expect((await send('comanda_item.cancel', { itemId: d.items[0].id, reason: 'x' })).message).toBe('Informe o motivo');
    expect((await send('comanda_item.cancel', { itemId: d.items[0].id, reason: 'Lançado errado' })).status).toBe('applied');
    d = await owner.ok('GET', `/api/comandas/${comandaId}`);
    expect(d.items[0].status).toBe('canceled');
    expect((await owner.ok('GET', `/api/products/${beer.id}`)).stockQty).toBe(24_000);

    expect(await send('cash.close', { countedCashCents: 10_000 })).toMatchObject({ status: 'applied', message: 'Caixa fechado.' });
    // Fica no histórico com o nome de quem mandou pelo painel.
    const history = env.s.db.all<{ action: string; user_name: string }>("SELECT action, user_name FROM audit_log WHERE action IN ('comandas.opened', 'cash.closed')");
    expect(history.map((h) => h.user_name)).toEqual(['Marina (painel online)', 'Marina (painel online)']);
  });

  it('exclui funcionário (não o proprietário) e tira produto da venda', async () => {
    await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const davi = (await owner.ok('GET', '/api/users')).find((u: { email: string }) => u.email === 'davi@bar.com');
    const ownerUser = (await owner.ok('GET', '/api/users')).find((u: { roleKey: string }) => u.roleKey === 'owner');
    expect((await send('user.remove', { userId: ownerUser.id })).message).toBe('O proprietário não pode ser excluído.');
    expect(await send('user.remove', { userId: davi.id })).toMatchObject({ status: 'applied', message: 'Davi excluído(a).' });
    expect((await owner.ok('GET', '/api/users')).map((u: { name: string }) => u.name)).not.toContain('Davi');
    // Não entra mais e o e-mail fica livre para um novo cadastro.
    const login = await new Client(env.app, '192.168.0.60').req('POST', '/api/auth/login', { email: 'davi@bar.com', password: 'Senha-Forte-99' });
    expect(login.statusCode).toBe(401);
    await createStaff(env, owner, 'waiter', 'Davi Novo', 'davi@bar.com');

    const beers = await category(owner, 'Cervejas');
    const p = await owner.ok('POST', '/api/products', { name: 'Skol lata', categoryId: beers, measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 600 }] });
    expect(await send('product.set_active', { productId: p.id, active: false })).toMatchObject({ status: 'applied', message: 'Skol lata saiu da venda.' });
    expect((await owner.ok('GET', '/api/menu')).items.some((i: { productId: string }) => i.productId === p.id)).toBe(false);
    expect((await send('product.set_active', { productId: p.id, active: true })).message).toBe('Skol lata voltou à venda.');
    expect((await owner.ok('GET', '/api/menu')).items.some((i: { productId: string }) => i.productId === p.id)).toBe(true);
  });

  it('dado inválido ou comando desconhecido é recusado com o motivo, sem aplicar nada', async () => {
    expect(await send('order.create', { comandaId: uuid(), items: [] })).toMatchObject({ status: 'rejected' });
    expect((await send('comanda_item.cancel', { itemId: uuid(), reason: 'Errado' })).message).toBe('Item não encontrado.');
    const unknown = await env.s.sync.applyCommand({ id: uuid(), type: 'x.y' as RemoteCommand['type'], payload: {}, createdAt: '', createdBy: null });
    expect(unknown).toMatchObject({ status: 'rejected', message: 'Comando desconhecido: x.y' });
  });

  it('no PC: o dono exclui funcionário pela tela de Funcionários', async () => {
    await createStaff(env, owner, 'waiter', 'Rafa', 'rafa@bar.com');
    const rafa = (await owner.ok('GET', '/api/users')).find((u: { email: string }) => u.email === 'rafa@bar.com');
    const manager = await createStaff(env, owner, 'manager', 'Gerente', 'g@bar.com');
    expect((await manager.fail('POST', `/api/users/${rafa.id}/remove`)).status).toBe(403);
    expect(await owner.ok('POST', `/api/users/${rafa.id}/remove`)).toMatchObject({ name: 'Rafa' });
    expect((await owner.fail('POST', `/api/users/${rafa.id}/remove`)).status).toBe(404);
  });
});
