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

/** Whisky de 1 L com doses de 30, 50 e 100 ml usando o mesmo estoque. */
async function createWhisky(minStockMl = 500) {
  const cat = await category(owner, 'Destilados');
  const { id } = await owner.ok('POST', '/api/products', {
    name: 'Whisky 12 anos', categoryId: cat, measure: 'volume', packageQty: 1_000_000, packageLabel: 'garrafa 1 L',
    minStock: minStockMl * 1000, stockTracked: true,
    presentations: [
      { name: 'Dose 30 ml', priceCents: 1800, components: [{ productId: null, qty: 30_000 }] },
      { name: 'Dose 50 ml', priceCents: 2800, components: [{ productId: null, qty: 50_000 }] },
      { name: 'Dose dupla 100 ml', priceCents: 5200, components: [{ productId: null, qty: 100_000 }] },
    ],
  });
  await owner.ok('POST', '/api/stock/purchases', {
    items: [{ productId: id, packages: 2, packageQty: 1_000_000, totalCostCents: 24_000 }],
    invoiceNumber: '1234',
  });
  const p = await owner.ok('GET', `/api/products/${id}`);
  const pres = Object.fromEntries(p.presentations.map((x: { name: string; id: string }) => [x.name, x.id]));
  return { id, pres };
}

async function openComanda(c: Client, name = 'Carlos Lima', table = '7') {
  return c.ok('POST', '/api/comandas', { customerName: name, table, customerPhone: '(11) 98765-4321', customerCpf: '529.982.247-25' });
}

async function stockOf(productId: string) {
  return (await owner.ok('GET', `/api/products/${productId}`)).stockQty as number;
}

describe('estoque por mililitro e pedidos', () => {
  it('vender 50 ml desconta exatamente 50 ml; doses diferentes usam o mesmo estoque', async () => {
    const w = await createWhisky();
    expect(await stockOf(w.id)).toBe(2_000_000);
    const p = await owner.ok('GET', `/api/products/${w.id}`);
    expect(p.unitCostE4).toBe(120_000); // R$ 0,12/ml
    expect(p.packages).toEqual({ closed: 2, openRemaining: 0, hasOpen: false });
    expect(p.theoreticalYield).toBe(33); // doses de 30 ml por garrafa

    const c = await openComanda(owner);
    const order = await owner.ok('POST', '/api/orders', {
      comandaId: c.id, clientRequestId: uuid(),
      items: [{ presentationId: w.pres['Dose 50 ml'], quantity: 1 }, { presentationId: w.pres['Dose 30 ml'], quantity: 2 }, { presentationId: w.pres['Dose dupla 100 ml'], quantity: 1 }],
    });
    expect(order.number).toBe(1);
    expect(await stockOf(w.id)).toBe(2_000_000 - 50_000 - 60_000 - 100_000);
    const after = await owner.ok('GET', `/api/products/${w.id}`);
    expect(after.packages).toEqual({ closed: 1, openRemaining: 790_000, hasOpen: true });

    const detail = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(detail.total).toBe(2800 + 2 * 1800 + 5200);
    const dose50 = detail.items.find((i: { presentationName: string }) => i.presentationName === 'Dose 50 ml');
    expect(dose50.unitCostCents).toBe(600); // custo exato por dose
    // Dados pessoais aparecem mascarados
    expect(detail.customerCpfMasked).toBe('***.982.247-**');
    expect(detail.customerPhoneMasked).toBe('(11) *****-4321');
    expect(JSON.stringify(detail)).not.toContain('52998224725');
  });

  it('reenvio do mesmo pedido (toque duplo / queda de conexão) não duplica nem desconta duas vezes', async () => {
    const w = await createWhisky();
    const c = await openComanda(owner);
    const body = { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose 50 ml'], quantity: 1 }] };
    const [a, b] = await Promise.all([owner.ok('POST', '/api/orders', body), owner.ok('POST', '/api/orders', body)]);
    expect(a.id).toBe(b.id);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await stockOf(w.id)).toBe(1_950_000);
    const detail = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(detail.items).toHaveLength(1);
  });

  it('cancelamento justificado devolve ao estoque uma única vez e fica auditado', async () => {
    const w = await createWhisky();
    const c = await openComanda(owner);
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose 50 ml'], quantity: 2 }] });
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    const itemId = d.items[0].id;
    expect((await owner.fail('POST', `/api/comanda-items/${itemId}/cancel`, { reason: '' })).code).toBe('VALIDATION');
    await owner.ok('POST', `/api/comanda-items/${itemId}/cancel`, { reason: 'Cliente desistiu', returnToStock: true });
    expect(await stockOf(w.id)).toBe(2_000_000);
    expect((await owner.fail('POST', `/api/comanda-items/${itemId}/cancel`, { reason: 'De novo' })).code).toBe('ALREADY_CANCELED');
    expect(await stockOf(w.id)).toBe(2_000_000);
    const audit = await owner.ok('GET', `/api/audit?entity=comanda_item&entityId=${itemId}`);
    expect(audit[0].action).toBe('comandas.item_canceled');
    // movimentações são imutáveis
    expect(() => env.s.db.run('DELETE FROM stock_movements')).toThrow(/imutáveis/);
  });

  it('ficha técnica: hambúrguer baixa pão, carne e queijo; drink baixa destilado e limão', async () => {
    const ing = await category(owner, 'Outros');
    const mk = async (name: string, measure: string, qty: number) => {
      const { id } = await owner.ok('POST', '/api/products', { name, categoryId: ing, measure, packageQty: 1000, menuVisible: false });
      await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: id, packages: qty, packageQty: 1000, totalCostCents: qty * 100 }] });
      return id as string;
    };
    const pao = await mk('Pão brioche', 'unit', 10);
    const carne = await mk('Blend 160 g', 'unit', 10);
    const queijo = await mk('Queijo fatia', 'unit', 20);
    const meals = await category(owner, 'Refeições');
    const burger = await owner.ok('POST', '/api/products', {
      name: 'Hambúrguer da casa', categoryId: meals, measure: 'unit', stockTracked: false,
      presentations: [{ name: 'Unidade', priceCents: 3500, components: [{ productId: pao, qty: 1000 }, { productId: carne, qty: 1000 }, { productId: queijo, qty: 2000 }] }],
    });
    const bp = (await owner.ok('GET', `/api/products/${burger.id}`)).presentations[0];
    expect(bp.available).toBe(10);
    const c = await openComanda(owner);
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: bp.id, quantity: 3, notes: 'sem cebola' }] });
    expect(await stockOf(pao)).toBe(7000);
    expect(await stockOf(carne)).toBe(7000);
    expect(await stockOf(queijo)).toBe(14_000);
    const d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items[0].unitCostCents).toBe(400); // 1 pão + 1 carne + 2 queijos a R$ 1,00
  });

  it('bloqueia venda sem estoque (configuração padrão) informando o produto', async () => {
    const w = await createWhisky();
    const c = await openComanda(owner);
    const f = await owner.fail('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose dupla 100 ml'], quantity: 21 }] });
    expect(f.code).toBe('OUT_OF_STOCK');
    expect(f.message).toContain('Whisky 12 anos');
    expect(await stockOf(w.id)).toBe(2_000_000); // transação revertida
  });

  it('alerta de estoque mínimo abre uma única vez por episódio e resolve na reposição', async () => {
    const w = await createWhisky(1_500);
    const c = await openComanda(owner);
    const sell = (n: number) => owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose dupla 100 ml'], quantity: n }] });
    await sell(5); // 1500 ml → atinge o mínimo
    await sell(1);
    await sell(1);
    let alerts = await owner.ok('GET', '/api/stock/alerts');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].suggestion.packages).toBeGreaterThan(0);
    expect(env.s.db.value("SELECT COUNT(*) FROM stock_alerts")).toBe(1);
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: w.id, packages: 3, packageQty: 1_000_000, totalCostCents: 36_000 }] });
    alerts = await owner.ok('GET', '/api/stock/alerts');
    expect(alerts).toHaveLength(0);
  });

  it('pedido com comida e bebida gera um ticket por setor e numeração sequencial do dia', async () => {
    const w = await createWhisky();
    const porcoes = await category(owner, 'Porções');
    const fritas = await owner.ok('POST', '/api/products', {
      name: 'Batata frita', categoryId: porcoes, measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3000 }],
    });
    const fp = (await owner.ok('GET', `/api/products/${fritas.id}`)).presentations[0].id;
    const c = await openComanda(owner);
    const o1 = await owner.ok('POST', '/api/orders', {
      comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: fp, quantity: 1 }, { presentationId: w.pres['Dose 50 ml'], quantity: 1 }],
    });
    expect(o1.tickets.map((t: { station: string }) => t.station).sort()).toEqual(['bar', 'kitchen']);
    const kitchen = await owner.ok('GET', '/api/kitchen/board?station=kitchen');
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0].items).toEqual([expect.objectContaining({ name: 'Batata frita — Porção', quantity: 1 })]);
    expect(kitchen[0].customerFirstName).toBe('Carlos');
    const bar = await owner.ok('GET', '/api/kitchen/board?station=bar');
    expect(bar[0].items[0].name).toContain('Whisky');
    const o2 = await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: fp, quantity: 1 }] });
    expect(o2.number).toBe(2);
    // virada do dia de operação (05:00, horário local) reinicia a numeração
    env.clock.advance(11 * 3_600_000);
    const o3 = await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: fp, quantity: 1 }] });
    expect(o3.number).toBe(1);
  });

  it('fluxo da cozinha: aceitar, preparar, pronto, chamar cliente e entregar', async () => {
    const porcoes = await category(owner, 'Porções');
    const fritas = await owner.ok('POST', '/api/products', {
      name: 'Batata frita', categoryId: porcoes, measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3000 }],
    });
    const fp = (await owner.ok('GET', `/api/products/${fritas.id}`)).presentations[0].id;
    const kitchenUser = await createStaff(env, owner, 'kitchen', 'Chef Rui', 'rui@bar.com');
    const c = await openComanda(owner, 'Carlos Alberto Lima');
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: fp, quantity: 2 }] });
    const [t] = await kitchenUser.ok('GET', '/api/kitchen/board?station=kitchen');
    await kitchenUser.ok('POST', `/api/kitchen/tickets/${t.id}/accept`);
    await kitchenUser.ok('POST', `/api/kitchen/tickets/${t.id}/status`, { status: 'preparing' });
    expect((await kitchenUser.fail('POST', `/api/kitchen/tickets/${t.id}/status`, { status: 'delivered' })).code).toBe('INVALID_TRANSITION');
    let tv = env.s.tv.board();
    expect(tv.preparing).toEqual([{ number: 1, name: 'Carlos', displayName: 'Carlos L.', comandaDisplayNumber: c.number }]);
    const events: { type: string; data?: Record<string, unknown> }[] = [];
    env.s.ctx.bus.subscribe((e) => e.channel === 'tv' && events.push(e));
    const called = await kitchenUser.ok('POST', `/api/kitchen/tickets/${t.id}/call`);
    expect(called.text).toBe(`Carlos, comanda ${c.number === 1 ? 'um' : c.number}. Seu pedido está pronto, retirar no balcão.`);
    expect(called.status).toBe('ready');
    const call = events.find((e) => e.type === 'pickup.call')!;
    expect(call.data).toMatchObject({ number: 1, customerFirstName: 'Carlos', customerDisplayName: 'Carlos L.', comandaDisplayNumber: c.number });
    tv = env.s.tv.board();
    expect(tv.ready[0]).toMatchObject({ number: 1, name: 'Carlos' });
    // A TV nunca recebe CPF, telefone ou valores
    const tvJson = JSON.stringify(env.s.tv.board());
    expect(tvJson).not.toMatch(/529|98765|priceCents|Alberto/);
    await kitchenUser.ok('POST', `/api/kitchen/tickets/${t.id}/status`, { status: 'delivered' });
    expect(env.s.tv.board().ready).toHaveLength(0);
    // cozinha não tem acesso ao caixa
    expect((await kitchenUser.fail('GET', '/api/cash/current')).status).toBe(403);
  });
});

describe('comandas, pagamentos e caixa', () => {
  it('pagamentos parciais, troco, divisão, encerramento e controle de versão', async () => {
    const w = await createWhisky();
    const c = await openComanda(owner);
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose 50 ml'], quantity: 3 }] });
    expect((await owner.fail('POST', '/api/payments', { comandaId: c.id, method: 'pix', amountCents: 1000, clientRequestId: uuid() })).code).toBe('CASH_CLOSED');
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 20_000 });
    expect((await owner.fail('POST', '/api/cash/open', { openingBalanceCents: 0 })).code).toBe('CASH_ALREADY_OPEN');

    const split = await owner.ok('GET', `/api/comandas/${c.id}/split?parts=3`);
    expect(split.shares).toEqual([2800, 2800, 2800]);
    const payReq = { comandaId: c.id, method: 'pix', amountCents: 2800, payerLabel: 'Pessoa 1', clientRequestId: uuid() };
    await owner.ok('POST', '/api/payments', payReq);
    const dup = await owner.ok('POST', '/api/payments', payReq);
    expect(dup.duplicate).toBe(true);
    const cash = await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'cash', amountCents: 2800, receivedCents: 5000, clientRequestId: uuid() });
    expect(cash.changeCents).toBe(2200);
    expect((await owner.fail('POST', '/api/payments', { comandaId: c.id, method: 'debit', amountCents: 9999, clientRequestId: uuid() })).code).toBe('OVERPAYMENT');

    let d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.remaining).toBe(2800);
    expect((await owner.fail('POST', `/api/comandas/${c.id}/close`, { expectedVersion: d.version })).code).toBe('BALANCE_DUE');

    // Outro dispositivo altera a comanda: a versão antiga é recusada
    const stale = d.version;
    await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'credit', amountCents: 2800, clientRequestId: uuid() });
    expect((await owner.fail('POST', `/api/comandas/${c.id}/close`, { expectedVersion: stale })).code).toBe('STALE_VERSION');
    d = await owner.ok('GET', `/api/comandas/${c.id}`);
    const closed = await owner.ok('POST', `/api/comandas/${c.id}/close`, { expectedVersion: d.version });
    expect(closed.status).toBe('closed');
    expect((await owner.fail('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose 50 ml'], quantity: 1 }] })).code).toBe('COMANDA_NOT_OPEN');
  });

  it('transferência de mesa, mover itens, desconto e taxa de serviço', async () => {
    const w = await createWhisky();
    const a = await openComanda(owner, 'Ana', '3');
    const b = await openComanda(owner, 'Bruno', '4');
    await owner.ok('POST', '/api/orders', { comandaId: a.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose 30 ml'], quantity: 1 }, { presentationId: w.pres['Dose 50 ml'], quantity: 1 }] });
    let da = await owner.ok('GET', `/api/comandas/${a.id}`);
    const t = await owner.ok('POST', `/api/comandas/${a.id}/transfer`, { table: '10', expectedVersion: da.version });
    expect(t.table).toBe('10');
    da = await owner.ok('GET', `/api/comandas/${a.id}`);
    const moved = await owner.ok('POST', `/api/comandas/${a.id}/move-items`, { itemIds: [da.items[0].id], targetComandaId: b.id, expectedVersion: da.version });
    expect(moved.from.total).toBe(2800);
    expect(moved.to.total).toBe(1800);
    const fee = await owner.ok('POST', `/api/comandas/${b.id}/service-fee`, { serviceFeeBp: 1000, expectedVersion: moved.to.version });
    expect(fee.total).toBe(1980);
    const disc = await owner.ok('POST', `/api/comandas/${b.id}/discount`, { discountCents: 300, reason: 'Cortesia', expectedVersion: fee.version });
    expect(disc.total).toBe(Math.round((1800 - 300) * 1.1));
  });

  it('sangria com comprovante, suprimento e fechamento com diferença (dois responsáveis)', async () => {
    const cashier = await createStaff(env, owner, 'cashier', 'Caixa Bia', 'bia@bar.com');
    await cashier.ok('POST', '/api/cash/open', { openingBalanceCents: 10_000 });
    const w = await createWhisky();
    const c = await openComanda(cashier);
    await cashier.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: w.pres['Dose 50 ml'], quantity: 2 }] });
    await cashier.ok('POST', '/api/payments', { comandaId: c.id, method: 'cash', amountCents: 5600, receivedCents: 6000, clientRequestId: uuid() });

    // comprovante (PDF) anexado à sangria
    const boundary = '----rupbar';
    const pdf = Buffer.from('%PDF-1.4\n%fake\n');
    const upload = await env.app.inject({
      method: 'POST', url: '/api/attachments?kind=receipt', remoteAddress: '192.168.0.50',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-rupbar': '1', cookie: cashier.cookie },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nota.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        pdf, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(upload.statusCode).toBe(200);
    const att = upload.json();
    expect(att.mime).toBe('application/pdf');
    const big = await cashier.fail('POST', '/api/cash/movements', { type: 'withdrawal', amountCents: 999_999, reason: 'Teste', clientRequestId: uuid() });
    expect(big.code).toBe('WITHDRAWAL_EXCEEDS_CASH');
    await cashier.ok('POST', '/api/cash/movements', { type: 'withdrawal', amountCents: 3_000, reason: 'Pagamento de gelo', attachmentId: att.id, clientRequestId: uuid() });
    await cashier.ok('POST', '/api/cash/movements', { type: 'supply', amountCents: 1_000, reason: 'Troco extra', clientRequestId: uuid() });

    const manager = await createStaff(env, owner, 'manager', 'Gerente Leo', 'leo@bar.com');
    const closed = await manager.ok('POST', '/api/cash/close', { countedCashCents: 13_500 });
    expect(closed.expectedCashCents).toBe(10_000 + 5_600 + 1_000 - 3_000);
    expect(closed.differenceCents).toBe(13_500 - 13_600);
    expect(closed.openedByName).toBe('Caixa Bia');
    expect(closed.closedByName).toBe('Gerente Leo');
    expect(() => env.s.db.run('UPDATE cash_movements SET amount_cents = 1')).toThrow(/imutáveis/);
    const sessions = await owner.ok('GET', '/api/cash/sessions');
    expect(sessions[0].summary.byMethod.cash).toBe(5600);
    expect((await manager.fail('GET', '/api/cash/sessions')).status).toBe(403);
  });
});

describe('impressão', () => {
  it('imprime automaticamente por setor, com fila persistente, nova tentativa e reimpressão', async () => {
    await owner.ok('POST', '/api/printers', { name: 'Cozinha', transport: 'network', host: '192.168.0.200', stations: ['kitchen'], paper: 80 });
    await owner.ok('POST', '/api/printers', { name: 'Balcão', transport: 'network', host: '192.168.0.201', stations: ['bar'], paper: 58 });
    const porcoes = await category(owner, 'Porções');
    const fritas = await owner.ok('POST', '/api/products', {
      name: 'Batata frita', categoryId: porcoes, measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3000 }],
    });
    const fp = (await owner.ok('GET', `/api/products/${fritas.id}`)).presentations[0].id;
    const c = await openComanda(owner);
    env.printerFail.on = true;
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: fp, quantity: 1, notes: 'bem crocante' }] });
    await env.s.printing.processQueue();
    let jobs = await owner.ok('GET', '/api/print-jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ printer_name: 'Cozinha', status: 'pending', attempts: 1, last_error: 'Impressora desligada' });
    // queda de energia no meio da impressão: trabalho volta para a fila
    env.s.db.run("UPDATE print_jobs SET status = 'printing'");
    expect(env.s.printing.recover()).toBe(1);
    env.printerFail.on = false;
    env.clock.advance(60_000);
    expect(await env.s.printing.processQueue()).toBe(1);
    expect(env.printed).toHaveLength(1);
    const text = Buffer.from(env.printed[0]!.bytes).toString('latin1');
    expect(text).toContain('PEDIDO 1');
    expect(text).toContain('bem crocante');
    expect(text).not.toContain('98765'); // telefone nunca é impresso
    jobs = await owner.ok('GET', '/api/print-jobs');
    await owner.ok('POST', `/api/print-jobs/${jobs[0].id}/reprint`);
    await env.s.printing.processQueue();
    expect(env.printed).toHaveLength(2);
  });
});

describe('cartões numerados e venda rápida', () => {
  it('cartão físico: único entre as comandas abertas, busca pelo número e edição', async () => {
    const a = await owner.ok('POST', '/api/comandas', { cardNumber: 23 });
    expect(a).toMatchObject({ cardNumber: 23, displayNumber: 23, label: 'Comanda 23', customerName: '' });
    const dup = await owner.fail('POST', '/api/comandas', { cardNumber: 23, customerName: 'Outro' });
    expect(dup.code).toBe('CARD_IN_USE');
    expect((await owner.fail('POST', '/api/comandas', {})).code).toBe('VALIDATION');
    expect((await owner.ok('GET', '/api/comandas/by-number/23')).id).toBe(a.id);
    expect(await owner.ok('GET', '/api/comandas/by-number/99')).toBeNull();
    // Comanda sem cartão é encontrada pelo número do sistema.
    const b = await owner.ok('POST', '/api/comandas', { customerName: 'Bia' });
    expect((await owner.ok('GET', `/api/comandas/by-number/${b.number}`)).id).toBe(b.id);
    // Trocar nome/cartão; cartão ocupado é recusado.
    const edited = await owner.ok('PATCH', `/api/comandas/${a.id}`, { customerName: 'Pedro Henrique', cardNumber: 24, expectedVersion: a.version });
    expect(edited).toMatchObject({ customerName: 'Pedro Henrique', cardNumber: 24 });
    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 23, customerName: 'Rita' });
    expect((await owner.fail('PATCH', `/api/comandas/${c.id}`, { cardNumber: 24, customerName: 'Rita', expectedVersion: c.version })).code).toBe('CARD_IN_USE');
    // Encerrada, o cartão volta a ficar livre.
    await owner.ok('POST', `/api/comandas/${b.id}/cancel`, { expectedVersion: b.version, reason: 'teste', returnToStock: false });
    const list = await owner.ok('GET', '/api/comandas?q=24');
    expect(list.map((x: { id: string }) => x.id)).toEqual([a.id]);
  });

  it('venda rápida: paga na hora, vai para a produção e a TV chama pelo nome', async () => {
    const porcoes = await category(owner, 'Porções');
    const fritas = await owner.ok('POST', '/api/products', {
      name: 'Batata frita', categoryId: porcoes, measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3000 }],
    });
    const fp = (await owner.ok('GET', `/api/products/${fritas.id}`)).presentations[0].id;
    const sale = { clientRequestId: uuid(), customerName: 'Juliana Prado', items: [{ presentationId: fp, quantity: 2 }] };
    // Pagamento diferente do total é recusado (nada é gravado).
    expect((await owner.fail('POST', '/api/quick-sales', { ...sale, payments: [{ method: 'pix', amountCents: 5000 }] })).code).toBe('PAYMENT_MISMATCH');
    // Dinheiro exige caixa aberto.
    expect((await owner.fail('POST', '/api/quick-sales', { ...sale, payments: [{ method: 'cash', amountCents: 6000, receivedCents: 10000 }] })).code).toBe('CASH_CLOSED');
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 10_000 });
    const r = await owner.ok('POST', '/api/quick-sales', { ...sale, payments: [{ method: 'cash', amountCents: 6000, receivedCents: 10000 }] });
    expect(r).toMatchObject({ totalCents: 6000, changeCents: 4000, callName: 'Juliana', waitsForPickup: true, duplicate: false });
    // Reenvio (toque duplo / queda de rede) não duplica.
    const again = await owner.ok('POST', '/api/quick-sales', { ...sale, payments: [{ method: 'cash', amountCents: 6000, receivedCents: 10000 }] });
    expect(again).toMatchObject({ comandaId: r.comandaId, duplicate: true });
    const d = await owner.ok('GET', `/api/comandas/${r.comandaId}`);
    expect(d).toMatchObject({ status: 'closed', kind: 'quick', displayNumber: null, total: 6000, paid: 6000 });
    // Não aparece entre as comandas abertas.
    expect((await owner.ok('GET', '/api/comandas')).find((x: { id: string }) => x.id === r.comandaId)).toBeUndefined();
    // Produção e TV: nome em destaque, sem número de comanda.
    const [t] = await owner.ok('GET', '/api/kitchen/board?station=kitchen');
    expect(t).toMatchObject({ customerDisplayName: 'Juliana P.', comandaDisplayNumber: null });
    const called = await owner.ok('POST', `/api/kitchen/tickets/${t.id}/call`);
    expect(called.text).toBe('Juliana, seu pedido está pronto. Retirar no balcão.');
    expect(env.s.tv.board().ready[0]).toMatchObject({ displayName: 'Juliana P.', comandaDisplayNumber: null });
    // Entra no caixa como venda normal.
    const cash = await owner.ok('GET', '/api/cash/current');
    expect(cash.summary.expectedCash).toBe(16_000);
  });

  it('TV: pedido pronto some sozinho depois do tempo configurado', async () => {
    const porcoes = await category(owner, 'Porções');
    const fritas = await owner.ok('POST', '/api/products', {
      name: 'Batata frita', categoryId: porcoes, measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3000 }],
    });
    const fp = (await owner.ok('GET', `/api/products/${fritas.id}`)).presentations[0].id;
    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 5, customerName: 'Rui' });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: fp, quantity: 1 }] });
    const [t] = await owner.ok('GET', '/api/kitchen/board?station=kitchen');
    await owner.ok('POST', `/api/kitchen/tickets/${t.id}/call`);
    expect(env.s.tv.board().ready).toHaveLength(1);
    env.clock.advance(9 * 60_000);
    expect(env.s.tv.board().ready).toHaveLength(1);
    env.clock.advance(2 * 60_000); // 11 min > 10 min (padrão)
    expect(env.s.tv.board().ready).toHaveLength(0);
    // "Nunca": só sai ao marcar entregue
    await owner.ok('PUT', '/api/tv/display', { readyMinutes: 0 });
    expect(env.s.tv.board().ready).toHaveLength(1);
  });
});
