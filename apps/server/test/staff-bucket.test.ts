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

const ALL_TIME = 'from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z';

async function beer(name: string, price: number, stock = 24) {
  const cat = env.s.db.value<string>("SELECT id FROM categories WHERE name = 'Cervejas'") ?? (await category(owner, 'Cervejas'));
  const p = await owner.ok('POST', '/api/products', {
    name, categoryId: cat, measure: 'unit', presentations: [{ name: 'Unidade', priceCents: price }],
    initialStock: { qty: stock * 1000, totalCostCents: stock * 500 },
  });
  const presentationId = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id as string;
  return { id: p.id as string, presentationId, cat };
}
const stockOf = async (id: string) => (await owner.ok('GET', `/api/products/${id}`)).stockQty as number;
const order = (comandaId: string, items: unknown[]) => owner.ok('POST', '/api/orders', { comandaId, clientRequestId: uuid(), items });

describe('comanda de funcionário', () => {
  it('baixa o estoque, não cobra, encerra sem pagamento e fica fora das vendas', async () => {
    await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const davi = (await owner.ok('GET', '/api/staff')).find((u: { name: string }) => u.name === 'Davi');
    const heineken = await beer('Heineken long neck', 1200);

    const staff = await owner.ok('POST', '/api/comandas', { staffUserId: davi.id });
    expect(staff).toMatchObject({ kind: 'staff', customerName: 'Davi', staffUserId: davi.id });
    await order(staff.id, [{ presentationId: heineken.presentationId, quantity: 2 }]);
    expect(await stockOf(heineken.id)).toBe(22_000);
    const d = await owner.ok('GET', `/api/comandas/${staff.id}`);
    expect(d).toMatchObject({ total: 2_400, remaining: 0 });

    // Cliente normal no mesmo período.
    const client = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    await order(client.id, [{ presentationId: heineken.presentationId, quantity: 1 }]);

    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    const pay = await owner.fail('POST', '/api/payments', { comandaId: staff.id, method: 'cash', amountCents: 100, clientRequestId: uuid() });
    expect(pay.code).toBe('STAFF_NO_PAYMENT');
    expect(await owner.ok('POST', `/api/comandas/${staff.id}/close`, { expectedVersion: d.version })).toMatchObject({ status: 'closed' });

    const sales = await owner.ok('GET', `/api/reports/sales?${ALL_TIME}`);
    expect(sales.grossCents).toBe(1_200);
    expect(sales.itemsSold).toBe(1);
    expect(sales.topProducts).toEqual([expect.objectContaining({ qty: 1, total: 1_200 })]);
    expect(sales.staffConsumption).toEqual([expect.objectContaining({ name: 'Davi', items: 2, value: 2_400, cost: 1_000 })]);
    expect((await owner.ok('GET', '/api/dashboard')).financial.salesCents).toBe(1_200);
  });

  it('item movido entre comanda de funcionário e de cliente troca de lado nos relatórios', async () => {
    const heineken = await beer('Heineken long neck', 1200);
    const me = (await owner.ok('GET', '/api/staff'))[0];
    const staff = await owner.ok('POST', '/api/comandas', { staffUserId: me.id });
    const client = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    await order(staff.id, [{ presentationId: heineken.presentationId, quantity: 1 }]);
    const item = (await owner.ok('GET', `/api/comandas/${staff.id}`)).items[0];
    await owner.ok('POST', `/api/comandas/${staff.id}/move-items`, { targetComandaId: client.id, itemIds: [item.id], expectedVersion: (await owner.ok('GET', `/api/comandas/${staff.id}`)).version });
    expect((await owner.ok('GET', `/api/reports/sales?${ALL_TIME}`)).grossCents).toBe(1_200);
    expect(env.s.db.value('SELECT staff FROM comanda_items WHERE id = ?', item.id)).toBe(0);
  });

  it('funcionário inexistente ou excluído não abre consumo', async () => {
    expect((await owner.fail('POST', '/api/comandas', { staffUserId: uuid() })).status).toBe(404);
  });
});

describe('excluir produto', () => {
  it('some das listas, do cardápio e das escolhas; código fica livre e o histórico continua', async () => {
    const heineken = await beer('Heineken long neck', 1200);
    const code = (await owner.ok('GET', `/api/products/${heineken.id}`)).internalCode;
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    await order(c.id, [{ presentationId: heineken.presentationId, quantity: 1 }]);
    const group = await owner.ok('POST', '/api/option-groups', { name: 'Cerveja', required: true, choices: [{ name: 'Heineken', productId: heineken.id, qty: 1000 }, { name: 'Sem' }] });

    expect(await owner.ok('DELETE', `/api/products/${heineken.id}`)).toMatchObject({ name: 'Heineken long neck' });
    expect((await owner.ok('GET', '/api/products?all=1')).map((p: { id: string }) => p.id)).not.toContain(heineken.id);
    expect((await owner.ok('GET', '/api/menu')).items.some((i: { productId: string }) => i.productId === heineken.id)).toBe(false);
    const choices = (await owner.ok('GET', '/api/option-groups')).find((g: { id: string }) => g.id === group.id).choices.map((x: { name: string }) => x.name);
    expect(choices).toEqual(['Sem']);
    // Vendas antigas continuam com o nome.
    expect((await owner.ok('GET', `/api/reports/sales?${ALL_TIME}`)).topProducts[0]).toMatchObject({ product_name: 'Heineken long neck', total: 1_200 });
    // Mesmo código pode ser usado num cadastro novo; o excluído não volta a ser editado.
    await owner.ok('POST', '/api/products', { name: 'Heineken nova', categoryId: heineken.cat, measure: 'unit', internalCode: code, presentations: [{ name: 'Unidade', priceCents: 1300 }] });
    expect((await owner.fail('POST', `/api/products/${heineken.id}/active`, { active: true })).status).toBe(404);
    expect((await owner.fail('DELETE', `/api/products/${heineken.id}`)).status).toBe(404);
  });

  it('não exclui o que é item de outro produto à venda', async () => {
    const gin = await beer('Gin garrafa', 15_000, 3);
    await owner.ok('POST', '/api/products', {
      name: 'Combo Gin', categoryId: gin.cat, measure: 'unit', stockTracked: false,
      presentations: [{ name: 'Combo', priceCents: 25_000, components: [{ productId: gin.id, qty: 1000 }] }],
    });
    const r = await owner.fail('DELETE', `/api/products/${gin.id}`);
    expect(r.code).toBe('PRODUCT_IN_USE');
    expect(r.message).toContain('Combo Gin');
  });

  it('o painel online recebe o produto como removido', async () => {
    const heineken = await beer('Heineken long neck', 1200);
    env.s.db.run("INSERT INTO meta (key, value) VALUES ('sync_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
    await owner.ok('DELETE', `/api/products/${heineken.id}`);
    const pushed: { entity: string; id: string; deleted: boolean }[] = [];
    // Captura o que iria para a nuvem.
    (env.s.sync as unknown as { api: { push: (c: unknown, r: typeof pushed) => Promise<{ acked: string[] }> } }).api.push = async (_c, records) => {
      pushed.push(...records);
      return { acked: [], rejected: [] } as unknown as { acked: string[] };
    };
    await (env.s.sync as unknown as { pushBatch: (c: unknown) => Promise<number> }).pushBatch({});
    expect(pushed.find((r) => r.entity === 'product' && r.id === heineken.id)).toMatchObject({ deleted: true });
  });
});

describe('balde de cerveja', () => {
  it('escolhe o balde e depois a cerveja: cobra o preço daquela cerveja e baixa as 5 unidades dela', async () => {
    const heineken = await beer('Heineken long neck', 1200, 12);
    const brahma = await beer('Brahma lata', 700, 4);
    // O mesmo que a tela "Novo balde" grava.
    const group = await owner.ok('POST', '/api/option-groups', {
      name: 'Cerveja do balde', required: true,
      choices: [
        { name: 'Heineken long neck', priceDeltaCents: 5_500, productId: heineken.id, qty: 5_000 },
        { name: 'Brahma lata', priceDeltaCents: 3_000, productId: brahma.id, qty: 5_000 },
      ],
    });
    const bucket = await owner.ok('POST', '/api/products', {
      name: 'Balde de cerveja', categoryId: heineken.cat, measure: 'unit', stockTracked: false,
      presentations: [{ name: 'Balde', priceCents: 0, components: [] }], optionGroups: [{ groupId: group.id, quantity: 1 }],
    });
    const menu = await owner.ok('GET', '/api/menu');
    const item = menu.items.find((i: { productId: string }) => i.productId === bucket.id);
    expect(item).toMatchObject({ priceCents: 0, optionGroupIds: [group.id] });
    // Só 4 Brahmas: o balde de Brahma aparece esgotado.
    expect(menu.optionGroups[group.id].choices.map((c: { name: string; soldOut: boolean }) => [c.name, c.soldOut])).toEqual([['Heineken long neck', false], ['Brahma lata', true]]);

    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Mesa 3' });
    const heinekenChoice = menu.optionGroups[group.id].choices[0].id;
    await order(c.id, [{ presentationId: item.presentationId, quantity: 1, options: [{ groupId: group.id, choiceId: heinekenChoice }] }]);
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items[0]).toMatchObject({ name: 'Balde de cerveja', options: 'Heineken long neck', unitPriceCents: 5_500 });
    expect(await stockOf(heineken.id)).toBe(7_000);
    // Sem escolher a cerveja não entra.
    expect((await owner.fail('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: item.presentationId, quantity: 1 }] })).status).toBe(400);
  });
});

describe('trocar item lançado', () => {
  async function water() {
    const cat = await category(owner, 'Cervejas');
    const mk = async (name: string, price: number) => {
      const p = await owner.ok('POST', '/api/products', {
        name, categoryId: cat, measure: 'unit', station: 'bar', presentations: [{ name: 'Unidade', priceCents: price }], initialStock: { qty: 10_000, totalCostCents: 1_000 },
      });
      return { id: p.id as string, presentationId: (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id as string };
    };
    return { still: await mk('Água sem gás', 500), sparkling: await mk('Água com gás', 600) };
  }

  it('acabou a água: sai a sem gás (volta ao estoque), entra a com gás num pedido novo para o bar', async () => {
    const w = await water();
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    await order(c.id, [{ presentationId: w.still.presentationId, quantity: 2 }]);
    const old = (await owner.ok('GET', `/api/comandas/${c.id}`)).items[0];
    const key = uuid();
    const r = await owner.ok('POST', `/api/comanda-items/${old.id}/swap`, { clientRequestId: key, items: [{ presentationId: w.sparkling.presentationId, quantity: 2 }], reason: 'Acabou' });
    expect(r).toMatchObject({ duplicate: false, swappedItemId: old.id });
    // Repetir o envio (rede caiu) não troca de novo.
    expect((await owner.ok('POST', `/api/comanda-items/${old.id}/swap`, { clientRequestId: key, items: [{ presentationId: w.sparkling.presentationId, quantity: 2 }] })).duplicate).toBe(true);
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items.map((i: { name: string; status: string; cancelReason: string | null }) => [i.name, i.status, i.cancelReason])).toEqual([
      ['Água sem gás', 'canceled', 'Trocado: Acabou'], ['Água com gás', 'active', null],
    ]);
    expect(d.total).toBe(1_200);
    expect(await stockOf(w.still.id)).toBe(10_000);
    expect(await stockOf(w.sparkling.id)).toBe(8_000);
    // O pedido antigo some do bar (ticket cancelado) e o novo chega com a observação.
    const tickets = env.s.db.all<{ order_id: string; status: string }>('SELECT order_id, status FROM order_tickets ORDER BY created_at');
    expect(tickets.map((t) => t.status)).toEqual(['canceled', 'received']);
    expect(env.s.db.value('SELECT notes FROM orders WHERE id = ?', tickets[1]!.order_id)).toBe('Troca de 2× Água sem gás');
  });

  it('trocar só a escolha (outro energético na dose)', async () => {
    const redbull = await beer('Red Bull', 1_000);
    const monster = await beer('Monster', 900);
    const group = await owner.ok('POST', '/api/option-groups', {
      name: 'Energético', required: true,
      choices: [{ name: 'Red Bull', priceDeltaCents: 800, productId: redbull.id, qty: 1000 }, { name: 'Monster', priceDeltaCents: 500, productId: monster.id, qty: 1000 }],
    });
    const dose = await owner.ok('POST', '/api/products', {
      name: 'Dose gin', categoryId: redbull.cat, measure: 'unit', stockTracked: false, presentations: [{ name: 'Dose', priceCents: 2_000, components: [] }], optionGroups: [{ groupId: group.id, quantity: 1 }],
    });
    const menu = await owner.ok('GET', '/api/menu');
    const item = menu.items.find((i: { productId: string }) => i.productId === dose.id);
    const [rb, mo] = menu.optionGroups[group.id].choices;
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    await order(c.id, [{ presentationId: item.presentationId, quantity: 1, options: [{ groupId: group.id, choiceId: rb.id }] }]);
    const old = (await owner.ok('GET', `/api/comandas/${c.id}`)).items[0];
    await owner.ok('POST', `/api/comanda-items/${old.id}/swap`, { clientRequestId: uuid(), items: [{ presentationId: item.presentationId, quantity: 1, options: [{ groupId: group.id, choiceId: mo.id }] }] });
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items.find((i: { status: string }) => i.status === 'active')).toMatchObject({ options: 'Monster', unitPriceCents: 2_500 });
    expect(await stockOf(redbull.id)).toBe(24_000);
    expect(await stockOf(monster.id)).toBe(23_000);
  });

  it('garçom troca o que ainda não ficou pronto; pronto ou depois de 30 min, só o gerente', async () => {
    const w = await water();
    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const c = await waiter.ok('POST', '/api/comandas', { customerName: 'Lia' });
    const launch = async () => {
      await waiter.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.still.presentationId, quantity: 1 }] });
      return (await owner.ok('GET', `/api/comandas/${c.id}`)).items.filter((i: { status: string; name: string }) => i.status === 'active' && i.name === 'Água sem gás').at(-1);
    };
    const swap = (who: Client, itemId: string) => who.req('POST', `/api/comanda-items/${itemId}/swap`, { clientRequestId: uuid(), items: [{ presentationId: w.sparkling.presentationId, quantity: 1 }] });

    expect((await swap(waiter, (await launch()).id)).statusCode).toBe(200);
    const ready = await launch();
    env.s.db.run("UPDATE order_tickets SET status = 'ready' WHERE order_id = (SELECT order_id FROM comanda_items WHERE id = ?)", ready.id);
    const denied = await waiter.fail('POST', `/api/comanda-items/${ready.id}/swap`, { clientRequestId: uuid(), items: [{ presentationId: w.sparkling.presentationId, quantity: 1 }] });
    expect(denied).toMatchObject({ status: 403, code: 'SWAP_NOT_ALLOWED' });
    const late = await launch();
    env.clock.advance(31 * 60_000);
    expect((await swap(waiter, late.id)).statusCode).toBe(403);
    expect((await swap(owner, late.id)).statusCode).toBe(200);
  });

  it('comanda já paga não fica com pagamento maior que o total (nada muda)', async () => {
    const w = await water();
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    await order(c.id, [{ presentationId: w.sparkling.presentationId, quantity: 1 }]);
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'cash', amountCents: 600, clientRequestId: uuid() });
    const old = (await owner.ok('GET', `/api/comandas/${c.id}`)).items[0];
    const r = await owner.fail('POST', `/api/comanda-items/${old.id}/swap`, { clientRequestId: uuid(), items: [{ presentationId: w.still.presentationId, quantity: 1 }] });
    expect(r.code).toBe('PAID_EXCEEDS_TOTAL');
    expect((await owner.ok('GET', `/api/comandas/${c.id}`)).items.map((i: { status: string }) => i.status)).toEqual(['active']);
    expect(await stockOf(w.sparkling.id)).toBe(9_000);
  });
});
