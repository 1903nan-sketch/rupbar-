import { describe, expect, it } from 'vitest';
import { encodeText, renderBillReceipt, renderOrderTicket, renderPickupTicket, twoColumns, wrap, EscPosBuilder, type BillReceiptData } from '../src/escpos';
import { parsePickupCode, pickupCode } from '../src/domain';
import { buildPixPayload } from '../src/pix';

describe('ESC/POS', () => {
  it('codifica acentos em CP850 e CP860', () => {
    expect(encodeText('ção', 'cp850')).toEqual([0x87, 0xc6, 0x6f]);
    expect(encodeText('ção', 'cp860')).toEqual([0x87, 0x84, 0x6f]);
    expect(encodeText('Ação', 'ascii')).toEqual([...Buffer.from('Acao')]);
  });
  it('quebra linhas e alinha colunas', () => {
    expect(wrap('Hambúrguer artesanal com queijo', 12)).toEqual(['Hambúrguer', 'artesanal', 'com queijo']);
    const l = twoColumns('2x Cerveja', 'R$ 20,00', 32);
    expect(l.length).toBe(32);
    expect(l.endsWith('R$ 20,00')).toBe(true);
  });
  it('inicializa, seleciona codepage e corta', () => {
    const bytes = new EscPosBuilder(58, 'cp850').line('Oi').cut().build();
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 2]);
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });
  it('cupom de pedido não contém CPF nem telefone', () => {
    const bytes = renderOrderTicket(
      {
        barName: 'Bar Teste', orderNumber: 42, stationLabel: 'Cozinha', table: '7', comandaNumber: 15,
        customerFirstName: 'Carlos', waiterName: 'Ana', createdAt: new Date('2026-01-01T23:00:00Z'),
        items: [{ quantity: 2, name: 'Porção de fritas', notes: 'sem sal' }],
      },
      { paper: 80, codepage: 'cp850' },
    );
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('PEDIDO 42');
    expect(text).toContain('Mesa: 7');
    expect(text).toContain('sem sal');
    expect(text).toContain('Carlos');
  });
});

/** Procura uma sequência de bytes dentro de outra. */
function indexOfSeq(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const QR_MODEL_2 = [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00];
const QR_PRINT = [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30];

describe('ESC/POS — QR Code (GS ( k, modelo 2)', () => {
  it('gera a sequência exata: modelo, módulo, correção M, gravação e impressão', () => {
    const bytes = [...new EscPosBuilder(80, 'ascii').qr('ABC', { moduleSize: 6 }).build()];
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]); // inicialização (ascii: sem seleção de codepage)
    expect(bytes.slice(2)).toEqual([
      ...QR_MODEL_2,
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06, // módulo de 6 pontos
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31, // correção de erros M
      0x1d, 0x28, 0x6b, 0x06, 0x00, 0x31, 0x50, 0x30, 0x41, 0x42, 0x43, // grava "ABC" (pL = 3 + 3)
      ...QR_PRINT,
    ]);
  });

  it('calcula pL/pH para conteúdos acima de 255 bytes e limita o módulo', () => {
    const data = 'x'.repeat(300);
    const bytes = new EscPosBuilder(58, 'ascii').qr(data, { moduleSize: 40, ec: 'H' }).build();
    const store = indexOfSeq(bytes, [0x1d, 0x28, 0x6b, 0x2f, 0x01, 0x31, 0x50, 0x30]); // 303 = 0x012F
    expect(store).toBeGreaterThan(0);
    expect(bytes[store + 8 + 299]).toBe(0x78);
    expect(indexOfSeq(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 16])).toBeGreaterThan(0);
    expect(indexOfSeq(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x33])).toBeGreaterThan(0);
    expect(new EscPosBuilder(80, 'ascii').qr('').build()).toHaveLength(2);
  });

  const bill = (pix: BillReceiptData['pix']): BillReceiptData => ({
    barName: 'Bar da Marina', comandaNumber: 12, table: '4', customerFirstName: 'Carlos',
    openedAt: new Date('2026-03-14T22:00:00Z'), printedAt: new Date('2026-03-14T23:00:00Z'),
    items: [{ quantity: 2, name: 'Chopp', total: 3000 }], subtotal: 3000, discount: 0, serviceFee: 0, total: 3000,
    payments: [{ label: 'Dinheiro', amount: 1000 }], remaining: 2000, pix,
  });

  it('conta com Pix: "Pague com Pix" + QR do saldo + valor', () => {
    const payload = buildPixPayload({ key: '52998224725', merchantName: 'Bar da Marina', merchantCity: 'Sao Paulo', amountCents: 2000, txid: 'RB12' });
    const bytes = renderBillReceipt(bill({ payload, amount: 2000, merchantName: 'Bar da Marina', keyLabel: 'CPF', key: '52998224725' }), { paper: 80, codepage: 'cp850' });
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('Pague com Pix');
    expect(text).toContain('R$ 20,00');
    const store = indexOfSeq(bytes, [0x1d, 0x28, 0x6b, (payload.length + 3) & 0xff, (payload.length + 3) >> 8, 0x31, 0x50, 0x30]);
    expect(store).toBeGreaterThan(0);
    expect(Buffer.from(bytes.slice(store + 8, store + 8 + payload.length)).toString('latin1')).toBe(payload);
    expect(indexOfSeq(bytes, QR_PRINT)).toBeGreaterThan(store);
    expect(indexOfSeq(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 7])).toBeGreaterThan(0); // 80 mm: módulo 7
  });

  it('impressora sem QR Code: imprime a chave em texto e nenhum comando GS ( k', () => {
    const payload = buildPixPayload({ key: '52998224725', merchantName: 'Bar da Marina', merchantCity: 'Sao Paulo', amountCents: 2000 });
    const bytes = renderBillReceipt(bill({ payload, amount: 2000, merchantName: 'Bar da Marina', keyLabel: 'CPF', key: '52998224725' }), { paper: 58, codepage: 'cp850', qr: false });
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('Pague com Pix');
    expect(text).toContain('52998224725');
    expect(indexOfSeq(bytes, [0x1d, 0x28, 0x6b])).toBe(-1);
  });

  it('sem Pix (ou sem saldo) a conta sai como antes', () => {
    const bytes = renderBillReceipt(bill(null), { paper: 80, codepage: 'cp850' });
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('Pague com Pix');
    expect(indexOfSeq(bytes, [0x1d, 0x28, 0x6b])).toBe(-1);
  });

  it('código do ticket: dia + número, lido de volta mesmo digitado com espaços', () => {
    expect(pickupCode('2026-10-16', 42)).toBe('RB2610160042');
    expect(pickupCode('2026-10-16', 123456)).toBe('RB261016123456');
    expect(parsePickupCode('rb 261016-0042')).toEqual({ businessDay: '2026-10-16', orderNumber: 42 });
    expect(parsePickupCode('RB2613160042')).toBeNull();
    expect(parsePickupCode('7891234567890')).toBeNull();
  });
  it('ticket do pedido: número, nome, itens, PAGO e código de barras CODE128 no conjunto C', () => {
    const data = {
      barName: 'Bar Teste', orderNumber: 42, code: 'RB2610160042', customerName: 'Juliana P.', comandaNumber: null, table: null,
      waiterName: 'Ana', createdAt: new Date('2026-10-16T23:00:00Z'), items: [{ quantity: 2, name: 'Heineken long neck' }],
      paid: { total: 3000, methods: ['Pix'] },
    };
    const bytes = renderPickupTicket(data, { paper: 58, codepage: 'cp850' });
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('PEDIDO 42');
    expect(text).toContain('Juliana P.');
    expect(text).toContain('2x Heineken long neck');
    expect(text).toContain('PAGO');
    expect(text).toContain('Pix');
    // GS k 73 n {B R B {C 26 10 16 00 42
    const bc = [0x1d, 0x6b, 73, 11, 0x7b, 0x42, 0x52, 0x42, 0x7b, 0x43, 26, 10, 16, 0, 42];
    expect(Buffer.from(bytes).includes(Buffer.from(bc))).toBe(true);
    const comanda = Buffer.from(renderPickupTicket({ ...data, paid: null, comandaNumber: 12, reprint: true }, { paper: 80, codepage: 'cp850' })).toString('latin1');
    expect(comanda).toContain('Comanda 12');
    expect(comanda).toContain('2');
    expect(comanda).not.toContain('PAGO');
  });
});
