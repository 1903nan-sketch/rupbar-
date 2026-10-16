import { pickupCode } from '@rupbar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db';
import { migrate, MIGRATIONS } from '../src/db/migrations';
import { parseWindowsPrinters } from '../src/services/printing';
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

/** Cerveja (sem setor: sai no balcão) e batata (cozinha), com o código de barras da cerveja. */
async function menu() {
  const beers = await category(owner, 'Cervejas');
  const food = await category(owner, 'Porções');
  const beer = await owner.ok('POST', '/api/products', {
    name: 'Heineken long neck', categoryId: beers, measure: 'unit', barcode: '7896045506873', station: 'none', stockTracked: false,
    presentations: [{ name: 'Unidade', priceCents: 1200 }],
  });
  const fries = await owner.ok('POST', '/api/products', {
    name: 'Batata frita', categoryId: food, measure: 'unit', station: 'kitchen', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3000 }],
  });
  const pres = async (id: string) => (await owner.ok('GET', `/api/products/${id}`)).presentations[0].id as string;
  return { beer: await pres(beer.id), fries: await pres(fries.id) };
}

const texts = () => env.printed.map((p) => ({ printer: p.printer, text: Buffer.from(p.bytes).toString('latin1') }));

describe('impressora do caixa', () => {
  it('uma impressora só: cada pedido sai no caixa como ticket (comanda e venda rápida paga), com 2ª via e conferência', async () => {
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'windows', windowsName: 'POS-58', paper: 58, cashier: true, printReceipts: true });
    expect((await owner.ok('GET', '/api/printers'))[0]).toMatchObject({ cashier: true, printReceipts: true });
    const m = await menu();
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });

    // Pedido na comanda: um ticket só, no caixa, com todos os itens (cozinha e balcão).
    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 12, customerName: 'Carlos Lima' });
    const order = await owner.ok('POST', '/api/orders', {
      comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: m.beer, quantity: 2 }, { presentationId: m.fries, quantity: 1 }],
    });
    await env.s.printing.processQueue();
    expect(env.printed).toHaveLength(1);
    let t = texts()[0]!;
    expect(t.printer).toBe('Caixa');
    expect(t.text).toContain(`PEDIDO ${order.number}`);
    expect(t.text).toContain('Carlos L.');
    expect(t.text).toContain('Comanda 12');
    expect(t.text).toContain('2x Heineken long neck');
    expect(t.text).toContain('1x Batata frita (Por');
    expect(t.text).not.toContain('PAGO');

    // Venda rápida: o ticket sai depois do pagamento, com PAGO e a forma.
    const sale = await owner.ok('POST', '/api/quick-sales', {
      clientRequestId: uuid(), customerName: 'Juliana Prado', items: [{ presentationId: m.beer, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 1200 }],
    });
    expect(sale.ticketPrinted).toBe(true);
    await env.s.printing.processQueue();
    expect(env.printed).toHaveLength(2);
    t = texts()[1]!;
    expect(t.text).toContain(`PEDIDO ${sale.orderNumber}`);
    expect(t.text).toContain('Juliana P.');
    expect(t.text).toContain('PAGO');
    expect(t.text).toContain('Pix');

    // Cliente perdeu o ticket: conferência pelo código bipado, pelo número ou pelo nome.
    const day = env.s.db.value<string>('SELECT business_day FROM orders WHERE id = ?', sale.orderId)!;
    const code = pickupCode(day, sale.orderNumber);
    let found = await owner.ok('GET', `/api/orders/lookup?q=${code}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ number: sale.orderNumber, quick: true, payment: 'paid', orderTotal: 1200, pickedUpAt: null, ticketPrints: 1, code });
    expect(found[0].payments).toEqual([expect.objectContaining({ method: 'pix', amount_cents: 1200 })]);
    expect((await owner.ok('GET', '/api/orders/lookup?q=juliana')).map((o: { id: string }) => o.id)).toEqual([sale.orderId]);
    found = await owner.ok('GET', `/api/orders/lookup?q=${order.number}`);
    expect(found.find((o: { id: string }) => o.id === order.id)).toMatchObject({ payment: 'open', remaining: 5400, quick: false });
    expect(await owner.ok('GET', '/api/orders/lookup?q=RB9912310001')).toEqual([]);

    // 2ª via: só quem recebe pagamentos; sai marcada.
    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    expect((await waiter.fail('POST', `/api/orders/${sale.orderId}/ticket`)).status).toBe(403);
    await owner.ok('POST', `/api/orders/${sale.orderId}/ticket`);
    await env.s.printing.processQueue();
    expect(texts()[2]!.text).toContain(' VIA');
    expect(texts()[2]!.text).toContain('PAGO');

    // Entregue no bar: registra quem e quando; não entrega duas vezes.
    const done = await waiter.ok('POST', `/api/orders/${sale.orderId}/picked-up`);
    expect(done).toMatchObject({ pickedUpBy: 'Davi', ticketPrints: 2 });
    expect(done.pickedUpAt).toBeTruthy();
    expect((await waiter.fail('POST', `/api/orders/${sale.orderId}/picked-up`)).code).toBe('ALREADY_PICKED_UP');
  });

  it('com impressora da cozinha: a cozinha recebe o cupom de produção e o caixa continua com o ticket de cada pedido', async () => {
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'windows', windowsName: 'POS-58', paper: 58, cashier: true, stations: ['kitchen', 'bar'] });
    await owner.ok('POST', '/api/printers', { name: 'Cozinha', transport: 'network', host: '192.168.0.50', stations: ['kitchen'] });
    const m = await menu();
    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 3 });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: m.fries, quantity: 1 }, { presentationId: m.beer, quantity: 1 }] });
    await env.s.printing.processQueue();
    const out = texts();
    expect(out.map((x) => x.printer).sort()).toEqual(['Caixa', 'Cozinha']);
    const kitchen = out.find((x) => x.printer === 'Cozinha')!.text;
    expect(kitchen).toContain('Batata frita');
    expect(kitchen).not.toContain('Heineken');
    const cashier = out.find((x) => x.printer === 'Caixa')!.text;
    expect(cashier).toContain('Batata frita');
    expect(cashier).toContain('Heineken');
  });

  it('reimpressão pela produção de um setor sem impressora própria sai no caixa; sem impressora do caixa a 2ª via explica', async () => {
    const m = await menu();
    const c = await owner.ok('POST', '/api/comandas', { cardNumber: 4 });
    const order = await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: m.fries, quantity: 1 }] });
    expect((await owner.fail('POST', `/api/orders/${order.id}/ticket`)).code).toBe('NO_CASHIER_PRINTER');
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'windows', windowsName: 'POS-58', cashier: true });
    const ticket = env.s.db.value<string>('SELECT id FROM order_tickets WHERE order_id = ?', order.id)!;
    await owner.ok('POST', `/api/kitchen/tickets/${ticket}/reprint`);
    await env.s.printing.processQueue();
    expect(texts()).toEqual([expect.objectContaining({ printer: 'Caixa', text: expect.stringContaining('REIMPRESSÃO'.normalize('NFC').slice(0, 7)) })]);
  });

  it('lista das impressoras do Windows: um objeto ou vários, com porta e driver', () => {
    expect(parseWindowsPrinters('{"Name":"POS-58","PortName":"USB001","DriverName":"POS-58 Printer","WorkOffline":false}')).toEqual([
      { name: 'POS-58', port: 'USB001', driver: 'POS-58 Printer', offline: false },
    ]);
    expect(parseWindowsPrinters('[{"Name":"A"},{"Name":"B","WorkOffline":true}]').map((p) => [p.name, p.offline])).toEqual([['A', false], ['B', true]]);
    expect(parseWindowsPrinters('')).toEqual([]);
    expect(parseWindowsPrinters('erro')).toEqual([]);
  });

  it('ao atualizar, a impressora única vira a do caixa (tudo sai nela)', () => {
    for (const count of [1, 2]) {
      const db = new Db(':memory:');
      try {
        const target = MIGRATIONS.find((m) => m.name.startsWith('impressora do caixa'))!;
        db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
        for (const m of MIGRATIONS.filter((x) => x.id < target.id)) {
          db.exec(m.sql);
          m.run?.(db);
          db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)', m.id, m.name, '2026-01-01T00:00:00Z');
        }
        for (let i = 0; i < count; i++) {
          db.run("INSERT INTO printers (id, name, transport, created_at, updated_at) VALUES (?, ?, 'windows', 'x', 'x')", `p${i}`, `P${i}`);
        }
        migrate(db);
        const flags = db.all<{ cashier: number }>('SELECT cashier FROM printers ORDER BY id').map((r) => r.cashier);
        expect(flags).toEqual(count === 1 ? [1] : [0, 0]);
      } finally {
        db.close();
      }
    }
  });
});
