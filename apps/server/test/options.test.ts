import { CASHIER_EXTRA } from '@rupbar/core';
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

  it('combo da garrafa: baixa a garrafa inteira, 5 gelos do sabor e 4 latas do energético escolhido; a dose baixa só os ml', async () => {
    const spirits = await category(owner, 'Destilados');
    const drinks = await category(owner, 'Drinks');
    // Garrafa vendida em dose (50 ml) e fechada.
    const gin = await owner.ok('POST', '/api/products', {
      name: 'Gin Rocks 1 L', categoryId: spirits, measure: 'volume', packageQty: 1_000_000,
      presentations: [
        { name: 'Dose 50 ml', priceCents: 1200, components: [{ productId: null, qty: 50_000 }] },
        { name: 'Garrafa', priceCents: 12_000, components: [{ productId: null, qty: 1_000_000 }] },
      ],
    });
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: gin.id, qty: 4_000_000, totalCostCents: 40_000 }] });
    const coco = await stocked('Gelo de coco', drinks, 'unit', 1000, 20_000);
    const melancia = await stocked('Gelo de melancia', drinks, 'unit', 1000, 20_000);
    const redbull = await stocked('Red Bull lata', drinks, 'unit', 1000, 24_000);
    const baly = await stocked('Baly lata', drinks, 'unit', 1000, 24_000);
    const ice = await owner.ok('POST', '/api/option-groups', {
      name: 'Sabor do gelo', choices: [{ name: 'Coco', productId: coco, qty: 1000 }, { name: 'Melancia', productId: melancia, qty: 1000 }],
    });
    const energy = await owner.ok('POST', '/api/option-groups', {
      name: 'Energético', choices: [{ name: 'Baly', productId: baly, qty: 1000 }, { name: 'Red Bull', priceDeltaCents: 500, productId: redbull, qty: 1000 }],
    });
    // Combo: a garrafa (fixa) + escolhas que valem 5 gelos e 4 latas.
    const combo = await owner.ok('POST', '/api/products', {
      name: 'Combo Gin Rocks', categoryId: drinks, measure: 'unit', stockTracked: false,
      presentations: [{ name: 'Combo', priceCents: 15_000, components: [{ productId: gin.id, qty: 1_000_000 }] }],
      optionGroups: [{ groupId: ice.id, quantity: 5 }, { groupId: energy.id, quantity: 4 }],
    });
    expect((await owner.ok('GET', `/api/products/${combo.id}`)).optionGroups).toEqual([{ groupId: ice.id, quantity: 5 }, { groupId: energy.id, quantity: 4 }]);
    const menu = await owner.ok('GET', '/api/menu');
    const item = menu.items.find((i: { productName: string }) => i.productName === 'Combo Gin Rocks');
    expect(item.optionQty).toEqual({ [ice.id]: 5, [energy.id]: 4 });
    const choice = (g: string, name: string) => menu.optionGroups[g].choices.find((c: { name: string }) => c.name === name).id;

    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 21 });
    await owner.ok('POST', '/api/orders', {
      comandaId: c.id, clientRequestId: uuid(),
      items: [{ presentationId: item.presentationId, quantity: 1, options: [{ groupId: ice.id, choiceId: choice(ice.id, 'Melancia') }, { groupId: energy.id, choiceId: choice(energy.id, 'Red Bull') }] }],
    });
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    // R$ 150 + 4 × R$ 5 do Red Bull.
    expect(d.items[0]).toMatchObject({ name: 'Combo Gin Rocks', options: '5× Melancia · 4× Red Bull', unitPriceCents: 17_000 });
    expect(await stockOf(gin.id)).toBe(3_000_000);
    expect(await stockOf(melancia)).toBe(15_000);
    expect(await stockOf(coco)).toBe(20_000);
    expect(await stockOf(redbull)).toBe(20_000);

    // Dose desconta só 50 ml; garrafa fechada desconta a garrafa inteira.
    const dose = (await owner.ok('GET', `/api/products/${gin.id}`)).presentations;
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: dose.find((p: { name: string }) => p.name === 'Dose 50 ml').id, quantity: 2 }] });
    expect(await stockOf(gin.id)).toBe(2_900_000);
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: dose.find((p: { name: string }) => p.name === 'Garrafa').id, quantity: 1 }] });
    expect(await stockOf(gin.id)).toBe(1_900_000);

    // Corrigir a quantidade do combo (conta mestre) rebaixa tudo multiplicado.
    await owner.ok('PUT', `/api/admin/comanda-items/${d.items[0].id}`, { quantity: 2, unitPriceCents: 17_000, reason: 'Eram dois combos' });
    expect(await stockOf(melancia)).toBe(10_000);
    expect(await stockOf(redbull)).toBe(16_000);
    expect(await stockOf(gin.id)).toBe(900_000);
  });

  it('mesma garrafa: dose pura, dose com energético (só ela pede a escolha) e garrafa fechada baixam do mesmo Jack', async () => {
    const spirits = await category(owner, 'Destilados');
    const drinks = await category(owner, 'Energéticos');
    const redbull = await stocked('Red Bull lata', drinks, 'unit', 1000, 24_000);
    const energy = await owner.ok('POST', '/api/option-groups', {
      name: 'Energético', required: true, choices: [{ name: 'Red Bull', priceDeltaCents: 500, productId: redbull, qty: 1000 }, { name: 'Sem energético' }],
    });
    const jack = await owner.ok('POST', '/api/products', {
      name: "Jack Daniel's 1 L", categoryId: spirits, measure: 'volume', packageQty: 1_000_000,
      presentations: [
        { name: 'Dose 50 ml', priceCents: 4000, components: [{ productId: null, qty: 50_000 }] },
        { name: 'Dose com energético', priceCents: 4000, components: [{ productId: null, qty: 50_000 }], optionGroups: [{ groupId: energy.id }] },
        { name: 'Garrafa fechada', priceCents: 40_000, components: [{ productId: null, qty: 1_000_000 }] },
      ],
      initialStock: { qty: 2_000_000, totalCostCents: 30_000 },
    });
    const view = await owner.ok('GET', `/api/products/${jack.id}`);
    expect(view.optionGroupIds).toEqual([]);
    expect(view.presentations.map((p: { name: string; optionGroups: unknown[] }) => [p.name, p.optionGroups.length])).toEqual([['Dose 50 ml', 0], ['Dose com energético', 1], ['Garrafa fechada', 0]]);

    const menu = await owner.ok('GET', '/api/menu');
    const item = (name: string) => menu.items.find((i: { productId: string; presentationName: string }) => i.productId === jack.id && i.presentationName === name);
    expect(item('Dose 50 ml').optionGroupIds).toEqual([]);
    expect(item('Dose com energético').optionGroupIds).toEqual([energy.id]);
    expect(item('Garrafa fechada').optionGroupIds).toEqual([]);
    expect((await owner.ok('GET', '/api/option-groups')).find((g: { id: string }) => g.id === energy.id).products.map((p: { name: string }) => p.name)).toEqual(["Jack Daniel's 1 L"]);

    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 9 });
    const order = (name: string, options: { groupId: string; choiceId: string }[] = []) =>
      owner.req('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: item(name).presentationId, quantity: 1, options }] });
    expect((await order('Dose 50 ml')).statusCode).toBe(200);
    expect((await order('Dose com energético')).json().error.code).toBe('OPTION_REQUIRED');
    const redBullChoice = menu.optionGroups[energy.id].choices.find((x: { name: string }) => x.name === 'Red Bull');
    expect((await order('Dose com energético', [{ groupId: energy.id, choiceId: redBullChoice.id }])).statusCode).toBe(200);
    expect((await order('Garrafa fechada')).statusCode).toBe(200);
    // Uma garrafa e duas doses do mesmo Jack; a lata só na dose com energético.
    expect(await stockOf(jack.id)).toBe(2_000_000 - 50_000 - 50_000 - 1_000_000);
    expect(await stockOf(redbull)).toBe(23_000);
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items.map((i: { totalCents: number }) => i.totalCents)).toEqual([4000, 4500, 40_000]);

    // Editar o produto sem mandar as escolhas da apresentação mantém as atuais.
    await owner.ok('PUT', `/api/products/${jack.id}`, {
      name: "Jack Daniel's 1 L", categoryId: spirits, measure: 'volume', packageQty: 1_000_000,
      presentations: view.presentations.map((p: { id: string; name: string; priceCents: number; components: { qty: number }[] }) => ({
        id: p.id, name: p.name, priceCents: p.priceCents, components: [{ productId: null, qty: p.components[0]!.qty }],
      })),
    });
    expect((await owner.ok('GET', `/api/products/${jack.id}`)).presentations[1].optionGroups).toEqual([{ groupId: energy.id, quantity: 1 }]);
  });

  it('meio a meio: cobra a porção mais cara e baixa metade de cada uma', async () => {
    const portions = await category(owner, 'Porções');
    const kg = (name: string) => owner.ok('POST', '/api/products', { name, categoryId: portions, measure: 'mass', packageQty: 1_000_000, menuVisible: false, initialStock: { qty: 5_000_000, totalCostCents: 10_000 } });
    const batata = await kg('Batata');
    const polenta = await kg('Polenta');
    const cheddar = await kg('Cheddar');
    const porcao = async (name: string, priceCents: number, components: { productId: string; qty: number }[]) => {
      const p = await owner.ok('POST', '/api/products', { name, categoryId: portions, measure: 'unit', stockTracked: false, presentations: [{ name, priceCents, components }] });
      return (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id as string;
    };
    const batataP = await porcao('Porção de batata', 3500, [{ productId: batata.id, qty: 400_000 }, { productId: cheddar.id, qty: 100_000 }]);
    const polentaP = await porcao('Porção de polenta', 3000, [{ productId: polenta.id, qty: 400_000 }]);
    expect((await owner.fail('POST', '/api/products', {
      name: 'Meio a meio ruim', categoryId: portions, measure: 'unit', stockTracked: false, presentations: [{ name: 'Meio a meio ruim', priceCents: 0, halves: [batataP] }],
    })).code).toBe('HALVES_MIN');
    const mix = await owner.ok('POST', '/api/products', {
      name: 'Porção meio a meio', categoryId: portions, measure: 'unit', stockTracked: false,
      presentations: [{ name: 'Porção meio a meio', priceCents: 0, halves: [batataP, polentaP] }],
    });
    const mixView = await owner.ok('GET', `/api/products/${mix.id}`);
    expect(mixView.presentations[0].halves).toEqual([batataP, polentaP]);
    const menu = await owner.ok('GET', '/api/menu');
    const item = menu.items.find((i: { productId: string }) => i.productId === mix.id);
    expect(item.halfParts.map((h: { name: string; priceCents: number; soldOut: boolean }) => [h.name, h.priceCents, h.soldOut])).toEqual([['Porção de batata', 3500, false], ['Porção de polenta', 3000, false]]);

    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 21 });
    const order = (halves: string[]) => owner.req('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: item.presentationId, quantity: 2, halves }] });
    expect((await order([batataP])).json().error.code).toBe('HALVES_REQUIRED');
    expect((await order([batataP, uuid()])).json().error.code).toBe('OPTION_UNAVAILABLE');
    expect((await order([polentaP, batataP])).statusCode).toBe(200);
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items[0]).toMatchObject({ name: 'Porção meio a meio', options: '½ Porção de polenta · ½ Porção de batata', unitPriceCents: 3500, totalCents: 7000 });
    // 2 meio a meio = 1 porção inteira de cada: 400 g de batata, 100 g de cheddar e 400 g de polenta.
    expect(await stockOf(batata.id)).toBe(5_000_000 - 400_000);
    expect(await stockOf(cheddar.id)).toBe(5_000_000 - 100_000);
    expect(await stockOf(polenta.id)).toBe(5_000_000 - 400_000);
    // Cancelar devolve as duas metades.
    await owner.ok('POST', `/api/comanda-items/${d.items[0].id}/cancel`, { reason: 'Cliente desistiu' });
    expect(await stockOf(batata.id)).toBe(5_000_000);
    expect(await stockOf(polenta.id)).toBe(5_000_000);
  });

  it('pedido pronto sai sozinho da tela de produção depois do tempo configurado', async () => {
    const drinks = await category(owner, 'Drinks');
    const p = await owner.ok('POST', '/api/products', { name: 'Caipirinha', categoryId: drinks, measure: 'unit', stockTracked: false, station: 'bar', presentations: [{ name: 'Unidade', priceCents: 2000 }] });
    const pres = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id;
    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 3 });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
    let board = await owner.ok('GET', '/api/kitchen/board?station=bar');
    await owner.ok('POST', `/api/kitchen/tickets/${board[0].id}/status`, { status: 'ready' });
    env.clock.advance(9 * 60_000);
    board = await owner.ok('GET', '/api/kitchen/board?station=bar');
    expect(board[0].status).toBe('ready');
    env.clock.advance(2 * 60_000);
    board = await owner.ok('GET', '/api/kitchen/board?station=bar');
    expect(board[0].status).toBe('delivered');
    // 0 = só sai ao marcar entregue.
    const op = await owner.ok('GET', '/api/settings/operation');
    await owner.ok('PUT', '/api/settings/operation', { ...op, kitchenReadyMinutes: 0 });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
    board = await owner.ok('GET', '/api/kitchen/board?station=bar');
    const fresh = board.find((t: { status: string }) => t.status === 'received');
    await owner.ok('POST', `/api/kitchen/tickets/${fresh.id}/status`, { status: 'ready' });
    env.clock.advance(60 * 60_000);
    expect(env.s.kitchen.sweepReady()).toBe(0);
  });

  it('garçom que também trabalha no caixa: abre o caixa e recebe; sem a opção, não', async () => {
    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    expect((await waiter.fail('POST', '/api/cash/open', { openingBalanceCents: 5_000 })).status).toBe(403);
    const users = await owner.ok('GET', '/api/users');
    const davi = users.find((u: { email: string }) => u.email === 'davi@bar.com');
    await owner.ok('PATCH', `/api/users/${davi.id}`, { name: davi.name, roleId: davi.roleId, status: 'active', grants: [...CASHIER_EXTRA], denies: [] });
    // Permissões mudaram: a sessão antiga cai; entra de novo.
    const again = new Client(env.app, '192.168.0.51');
    await again.ok('POST', '/api/auth/login', { email: 'davi@bar.com', password: 'Senha-Forte-99' });
    await again.ok('POST', '/api/cash/open', { openingBalanceCents: 5_000 });
    const drinks = await category(owner, 'Drinks');
    const p = await owner.ok('POST', '/api/products', { name: 'Água', categoryId: drinks, measure: 'unit', stockTracked: false, presentations: [{ name: 'Unidade', priceCents: 500 }] });
    const pres = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id;
    const c = await again.ok('POST', '/api/comandas', { cardNumber: 40 });
    await again.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
    await again.ok('POST', '/api/payments', { comandaId: c.id, method: 'pix', amountCents: 500, clientRequestId: uuid() });
    const d = await again.ok('GET', `/api/comandas/${c.id}`);
    await again.ok('POST', `/api/comandas/${c.id}/close`, { expectedVersion: d.version });
  });
});
