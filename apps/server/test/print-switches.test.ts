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

async function beer(): Promise<string> {
  const p = await owner.ok('POST', '/api/products', {
    name: 'Heineken', categoryId: await category(owner, 'Cervejas'), measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 1200 }],
    initialStock: { qty: 48_000, totalCostCents: 24_000 },
  });
  return (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id;
}
const kinds = () => env.s.db.all<{ kind: string; status: string }>('SELECT kind, status FROM print_jobs ORDER BY created_at');

describe('liga/desliga da impressão', () => {
  it('pedidos: desligado não sai papel; ligar descarta a fila parada e só os pedidos novos saem', async () => {
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'network', host: '192.168.0.210', paper: 80, cashier: true, printReceipts: true });
    const pres = await beer();
    const cashier = await createStaff(env, owner, 'cashier', 'Rafael', 'rafael@bar.com');
    expect(await cashier.ok('GET', '/api/printing/switches')).toEqual({ orders: true, quickTicket: true, quickReceipt: false, queued: 0 });

    // A impressora estava sem papel: o pedido ficou na fila (falhou).
    env.printerFail.on = true;
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Lia' });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
    await env.s.printing.processQueue();
    expect((await cashier.ok('GET', '/api/printing/switches')).queued).toBe(1);

    // O caixa desliga: a fila parada é descartada e os próximos pedidos não imprimem.
    const off = await cashier.ok('POST', '/api/printing/switches', { orders: false });
    expect(off).toMatchObject({ orders: false, discarded: 1, queued: 0 });
    env.printerFail.on = false;
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 2 }] });
    await env.s.printing.processQueue();
    expect(env.printed).toHaveLength(0);
    // Ficou gravado (vale para os próximos e para os outros aparelhos).
    expect((await owner.ok('GET', '/api/printing/switches')).orders).toBe(false);
    expect((await owner.ok('GET', '/api/settings/operation')).autoPrintOrders).toBe(false);

    // Liga de novo: nada do que ficou para trás sai; o pedido novo sai.
    expect(await cashier.ok('POST', '/api/printing/switches', { orders: true })).toMatchObject({ orders: true, discarded: 0 });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 3 }] });
    await env.s.printing.processQueue();
    expect(env.printed).toHaveLength(1);
    expect(Buffer.from(env.printed[0]!.bytes).toString('latin1')).toContain('3x');
    expect(kinds()).toEqual([
      { kind: 'pickup_ticket', status: 'canceled' },
      { kind: 'pickup_ticket', status: 'done' },
    ]);

    // Cozinha não liga nem desliga.
    const kitchen = await createStaff(env, owner, 'kitchen', 'Lu', 'lu@bar.com');
    expect((await kitchen.fail('POST', '/api/printing/switches', { orders: false })).status).toBe(403);
  });

  it('venda rápida: ticket e comprovante lembram a escolha', async () => {
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'network', host: '192.168.0.210', paper: 80, cashier: true, printReceipts: true });
    const pres = await beer();
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    const sale = () => owner.ok('POST', '/api/quick-sales', { clientRequestId: uuid(), customerName: 'Ana', items: [{ presentationId: pres, quantity: 1 }], payments: [{ method: 'pix', amountCents: 1200 }] });

    // Padrão: sai o ticket, sem comprovante.
    expect((await sale()).ticketPrinted).toBe(true);
    expect(kinds().map((k) => k.kind)).toEqual(['pickup_ticket']);

    // Desliga o ticket e liga o comprovante: as próximas vendas seguem a escolha sem marcar de novo.
    await owner.ok('POST', '/api/printing/switches', { quickTicket: false, quickReceipt: true });
    expect((await sale()).ticketPrinted).toBe(false);
    expect((await sale()).ticketPrinted).toBe(false);
    expect(kinds().map((k) => k.kind)).toEqual(['pickup_ticket', 'receipt', 'receipt']);

    // Os pedidos das comandas não mudam com o liga/desliga da venda rápida.
    expect((await owner.ok('GET', '/api/printing/switches')).orders).toBe(true);
    await owner.ok('POST', '/api/printing/switches', { quickReceipt: false });
    await sale();
    expect(kinds()).toHaveLength(3);
  });
});
