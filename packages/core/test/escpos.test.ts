import { describe, expect, it } from 'vitest';
import { encodeText, renderOrderTicket, twoColumns, wrap, EscPosBuilder } from '../src/escpos';

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
