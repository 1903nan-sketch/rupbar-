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

const stockOf = async (id: string) => (await owner.ok('GET', `/api/products/${id}`)).stockQty as number;

/** Produto de estoque com saldo inicial (em milli: 24 latas = 24_000; 2 garrafas de 1 L = 2_000_000). */
async function stocked(name: string, cat: string, measure: 'unit' | 'volume', packageQty: number, qty: number) {
  const p = await owner.ok('POST', '/api/products', { name, categoryId: cat, measure, packageQty, menuVisible: false });
  await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: p.id, qty, totalCostCents: 1000 }] });
  return p.id as string;
}

describe('escolhas no pedido', () => {
  it('dose de gin: escolhe o sabor, o energético e o gelo; preço soma e baixa a lata escolhida', async () => {
    const spirits = await category(owner, 'Destilados');
    const drinks = await category(owner, 'Drinks');
    const tanqueray = await stocked('Gin Tanqueray 750 ml', spirits, 'volume', 750_000, 1_500_000);
    const rocks = await stocked('Gin Rocks Morango 1 L', spirits, 'volume', 1_000_000, 1_000_000);
    const redbull = await stocked('Red Bull Tropical lata', drinks, 'unit', 1000, 24_000);
    const monster = await stocked('Monster lata', drinks, 'unit', 1000, 1_000);
    const ice = await stocked('Gelo de coco', drinks, 'unit', 1000, 10_000);

    const gin = await owner.ok('POST', '/api/option-groups', {
      name: 'Sabor do gin', required: true,
      choices: [{ name: 'Tanqueray', productId: tanqueray, qty: 50_000 }, { name: 'Rocks Morango', productId: rocks, qty: 50_000 }],
    });
    const energy = await owner.ok('POST', '/api/option-groups', {
      name: 'Energético', required: true,
      choices: [
        { name: 'Monster', priceDeltaCents: 500, productId: monster, qty: 1000 },
        { name: 'Red Bull Tropical', priceDeltaCents: 800, productId: redbull, qty: 1000 },
        { name: 'Sem energético' },
      ],
    });
    const iceGroup = await owner.ok('POST', '/api/option-groups', {
      name: 'Gelo', required: false,
      choices: [{ name: 'Gelo de coco', priceDeltaCents: 200, productId: ice, qty: 1000 }, { name: 'Gelo comum' }],
    });
    // Escolha com produto precisa dizer quanto sai do estoque.
    expect((await owner.fail('POST', '/api/option-groups', { name: 'X', choices: [{ name: 'Y', productId: ice }] })).status).toBe(400);

    const dose = await owner.ok('POST', '/api/products', {
      name: 'Gin com energético', categoryId: drinks, measure: 'unit', stockTracked: false,
      presentations: [{ name: 'Dose', priceCents: 1200 }], optionGroupIds: [gin.id, energy.id, iceGroup.id],
    });
    expect((await owner.ok('GET', `/api/products/${dose.id}`)).optionGroupIds).toEqual([gin.id, energy.id, iceGroup.id]);

    // Cardápio: as escolhas na ordem, com acréscimos.
    const menu = await owner.ok('GET', '/api/menu');
    const item = menu.items.find((i: { productName: string }) => i.productName === 'Gin com energético');
    expect(item.optionGroupIds).toEqual([gin.id, energy.id, iceGroup.id]);
    const choice = (g: string, name: string) => menu.optionGroups[g].choices.find((c: { name: string }) => c.name === name);
    expect(choice(energy.id, 'Red Bull Tropical')).toMatchObject({ priceDeltaCents: 800, soldOut: false });

    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 5 });
    const order = (options: { groupId: string; choiceId: string }[], quantity = 1) =>
      owner.req('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: item.presentationId, quantity, options }] });

    // Escolhas obrigatórias e uma por escolha.
    let r = await order([{ groupId: gin.id, choiceId: choice(gin.id, 'Tanqueray').id }]);
    expect(r.json().error.code).toBe('OPTION_REQUIRED');
    r = await order([
      { groupId: gin.id, choiceId: choice(gin.id, 'Tanqueray').id }, { groupId: gin.id, choiceId: choice(gin.id, 'Rocks Morango').id },
      { groupId: energy.id, choiceId: choice(energy.id, 'Monster').id },
    ]);
    expect(r.json().error.code).toBe('OPTION_MULTIPLE');

    // 2 doses: Rocks Morango + Red Bull Tropical + gelo de coco = 12 + 8 + 2 = R$ 22 cada.
    r = await order([
      { groupId: gin.id, choiceId: choice(gin.id, 'Rocks Morango').id },
      { groupId: energy.id, choiceId: choice(energy.id, 'Red Bull Tropical').id },
      { groupId: iceGroup.id, choiceId: choice(iceGroup.id, 'Gelo de coco').id },
    ], 2);
    expect(r.statusCode).toBe(200);
    let d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items[0]).toMatchObject({ name: 'Gin com energético', presentationName: 'Dose', options: 'Rocks Morango · Red Bull Tropical · Gelo de coco', unitPriceCents: 2200, totalCents: 4400 });
    expect(await stockOf(redbull)).toBe(22_000);
    expect(await stockOf(rocks)).toBe(900_000);
    expect(await stockOf(ice)).toBe(8_000);
    expect(await stockOf(tanqueray)).toBe(1_500_000);

    // Gelo é opcional; "Sem energético" não baixa nada.
    r = await order([{ groupId: gin.id, choiceId: choice(gin.id, 'Tanqueray').id }, { groupId: energy.id, choiceId: choice(energy.id, 'Sem energético').id }]);
    expect(r.statusCode).toBe(200);
    d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items[1]).toMatchObject({ options: 'Tanqueray · Sem energético', unitPriceCents: 1200 });
    expect(await stockOf(tanqueray)).toBe(1_450_000);

    // Cancelar o item devolve tudo o que as escolhas baixaram.
    await owner.ok('POST', `/api/comanda-items/${d.items[0].id}/cancel`, { reason: 'Pedido errado', returnToStock: true });
    expect(await stockOf(redbull)).toBe(24_000);
    expect(await stockOf(rocks)).toBe(1_000_000);
    expect(await stockOf(ice)).toBe(10_000);

    // Monster acabou: aparece esgotado e o pedido não passa.
    r = await order([{ groupId: gin.id, choiceId: choice(gin.id, 'Tanqueray').id }, { groupId: energy.id, choiceId: choice(energy.id, 'Monster').id }]);
    expect(r.statusCode).toBe(200);
    const after = await owner.ok('GET', '/api/menu');
    expect(after.optionGroups[energy.id].choices.find((x: { name: string }) => x.name === 'Monster').soldOut).toBe(true);
    r = await order([{ groupId: gin.id, choiceId: choice(gin.id, 'Tanqueray').id }, { groupId: energy.id, choiceId: choice(energy.id, 'Monster').id }]);
    expect(r.json().error.code).toBe('OUT_OF_STOCK');

    // Opção removida da escolha: pedidos novos com ela são recusados; os antigos continuam.
    await owner.ok('PUT', `/api/option-groups/${energy.id}`, {
      name: 'Energético', required: true,
      choices: [{ id: choice(energy.id, 'Red Bull Tropical').id, name: 'Red Bull Tropical', priceDeltaCents: 900, productId: redbull, qty: 1000 }],
    });
    r = await order([{ groupId: gin.id, choiceId: choice(gin.id, 'Tanqueray').id }, { groupId: energy.id, choiceId: choice(energy.id, 'Sem energético').id }]);
    expect(r.json().error.code).toBe('OPTION_UNAVAILABLE');
    const groups = await owner.ok('GET', '/api/option-groups');
    expect(groups.find((g: { id: string }) => g.id === energy.id).choices.map((x: { name: string; priceDeltaCents: number }) => [x.name, x.priceDeltaCents])).toEqual([['Red Bull Tropical', 900]]);
    expect(groups.find((g: { id: string }) => g.id === energy.id).products).toEqual([{ id: dose.id, name: 'Gin com energético' }]);
  });

  it('o cupom e a tela de produção mostram as escolhas', async () => {
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'windows', windowsName: 'POS-58', cashier: true, paper: 58 });
    const drinks = await category(owner, 'Drinks');
    const redbull = await stocked('Red Bull lata', drinks, 'unit', 1000, 5_000);
    const energy = await owner.ok('POST', '/api/option-groups', { name: 'Energético', choices: [{ name: 'Red Bull', priceDeltaCents: 800, productId: redbull, qty: 1000 }] });
    await owner.ok('POST', '/api/products', {
      name: 'Gin tônica', categoryId: drinks, measure: 'unit', stockTracked: false, station: 'bar',
      presentations: [{ name: 'Unidade', priceCents: 2000 }], optionGroupIds: [energy.id],
    });
    const menu = await owner.ok('GET', '/api/menu');
    const item = menu.items.find((i: { productName: string }) => i.productName === 'Gin tônica');
    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 9 });
    await owner.ok('POST', '/api/orders', {
      comandaId: c.id, clientRequestId: uuid(),
      items: [{ presentationId: item.presentationId, quantity: 1, options: [{ groupId: energy.id, choiceId: menu.optionGroups[energy.id].choices[0].id }] }],
    });
    await env.s.printing.processQueue();
    const text = Buffer.from(env.printed[0]!.bytes).toString('latin1');
    expect(text).toContain('1x Gin t');
    expect(text).toContain('+ Red Bull');
    const board = await owner.ok('GET', '/api/kitchen/board?station=bar');
    const tickets = Array.isArray(board) ? board : board.tickets ?? board.active ?? [];
    const ticketItems = JSON.stringify(tickets);
    expect(ticketItems).toContain('"options":"Red Bull"');
  });
});
