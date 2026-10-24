import { describe, expect, it } from 'vitest';
import { renderReportTicket } from '../src/escpos';
import { barDay, reportFileName, reportTitle, reportTotals, reportWindow, reportWindowLabel, type FullReport } from '../src/report';
import { PdfDoc, renderReportPdf, winAnsi } from '../src/report-pdf';

const report = (over: Partial<FullReport> = {}): FullReport => ({
  barName: 'Império J', from: '2026-10-24T08:00:00.000Z', to: '2026-10-25T08:00:00.000Z', de: '2026-10-24', ate: '2026-10-24',
  generatedAt: '2026-10-25T02:41:00.000Z',
  summary: {
    grossCents: 12_000, discountsCents: 1_500, serviceFeeCents: 0, receivedCents: 10_500, costCents: 5_000, itemsSold: 10, closedComandas: 1,
    quickSales: 1, canceledComandas: 0, canceledCents: 600, reversedCents: 0, staffCents: 0, lossesCents: 0, stillOpen: 0, stillOpenCents: 0,
  },
  payments: [{ method: 'pix', count: 2, totalCents: 10_500 }],
  byHour: [{ hour: 22, totalCents: 12_000 }], byDay: [], byCategory: [{ category: 'Cervejas', qty: 10, totalCents: 12_000, costCents: 5_000 }],
  products: [{ name: 'Heineken long neck', presentation: 'Unidade', qty: 10, totalCents: 12_000, costCents: 5_000 }],
  byWaiter: [{ name: 'Davi', orders: 2, totalCents: 12_000 }],
  discounts: [{ comanda: 'Comanda 14', customer: 'Bruno', reason: 'Cerveja quente (ação)', discountCents: 1_500, closedAt: '2026-10-25T02:00:00.000Z', closedBy: 'Rafael' }],
  cancellations: [{ at: '2026-10-25T01:00:00.000Z', product: 'Água com gás', qty: 1, totalCents: 600, reason: 'Trocado: Acabou', by: 'Davi' }],
  staffConsumption: [], cashSessions: [], cashMovements: [], losses: [], hookah: { sessions: 0, totalCents: 0 },
  ...over,
});

/** Lê o PDF como texto (o arquivo é ASCII depois do cabeçalho). */
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('dia do bar', () => {
  it('vai das 05:00 às 05:00 do dia seguinte (madrugada conta no dia da noite)', () => {
    expect(reportWindow('2026-10-24')).toEqual({ de: '2026-10-24', ate: '2026-10-24', from: '2026-10-24T08:00:00.000Z', to: '2026-10-25T08:00:00.000Z' });
    expect(reportWindow('2026-10-24', '2026-10-18')).toMatchObject({ de: '2026-10-18', ate: '2026-10-24', to: '2026-10-25T08:00:00.000Z' });
    expect(barDay(new Date('2026-10-25T06:30:00.000Z'))).toBe('2026-10-24'); // 03:30 em Brasília
    expect(barDay(new Date('2026-10-25T09:00:00.000Z'))).toBe('2026-10-25'); // 06:00
    expect(() => reportWindow('24/10/2026')).toThrow();
    expect(() => reportWindow('2026-02-30')).toThrow('Data inválida');
  });
  it('títulos e nome do arquivo', () => {
    expect(reportTitle('2026-10-24', '2026-10-24')).toBe('Sábado, 24/10/2026');
    expect(reportTitle('2026-10-18', '2026-10-24')).toBe('18/10/2026 a 24/10/2026');
    expect(reportWindowLabel('2026-10-31', '2026-10-31')).toBe('das 05:00 de 31/10 às 05:00 de 01/11');
    expect(reportFileName('2026-10-24', '2026-10-24')).toBe('vendas-2026-10-24.pdf');
    expect(reportTotals(report())).toMatchObject({ netCents: 10_500, marginCents: 7_000, marginPct: 58, tickets: 2, averageTicketCents: 5_250 });
  });
});

describe('PDF', () => {
  it('acentos do português em WinAnsi; o que não existe vira "?"', () => {
    expect(winAnsi('ção−→€“”')).toEqual([0xe7, 0xe3, 0x6f, 0x2d, 0x3e, 0x80, 0x93, 0x94]);
    expect(winAnsi('🍺')).toEqual([63]);
    const d = new PdfDoc();
    expect(d.measure('0000', 10)).toBeCloseTo(22.24);
    expect(d.fit('Porção de batata frita com cheddar', 60)).toMatch(/…$/);
    expect(d.measure(d.fit('Porção de batata frita com cheddar', 60), 10)).toBeLessThanOrEqual(60);
  });

  it('arquivo válido: referências apontam para os objetos, páginas e textos do relatório', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ name: `Produto ${i}`, presentation: 'Unidade', qty: 1, totalCents: 100, costCents: 50 }));
    const bytes = renderReportPdf(report({ products: many }));
    const raw = latin1(bytes);
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(raw)![1]);
    expect(raw.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...raw.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(raw.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    const pages = Number(/\/Count (\d+)/.exec(raw)![1]);
    expect(pages).toBeGreaterThanOrEqual(3);
    for (const m of raw.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = m.index! + m[0].length;
      expect(raw.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream');
    }
    // Textos (bytes acima de 127 vão como \ooo; parênteses escapados).
    expect(raw).toContain('(Recebimentos por forma de pagamento) Tj');
    expect(raw).toContain('(Cerveja quente \\(a\\347\\343o\\)) Tj');
    expect(raw).toContain('(Produtos vendidos \\(continua\\347\\343o\\)) Tj');
    expect(raw).toContain(`(P\\341gina 1 de ${pages}) Tj`);
  });
});

describe('cupom da impressora do caixa', () => {
  it('venda do dia com recebimentos, produtos e descontos', () => {
    const text = latin1(renderReportTicket(report(), { paper: 80, codepage: 'ascii' }));
    expect(text).toContain('VENDA DO DIA');
    expect(text).toMatch(/LIQUIDO\s+R\$ 105,00/);
    expect(text).toMatch(/Pix \(2\)\s+R\$ 105,00/);
    expect(text).toMatch(/10x Heineken long neck\s+R\$ 120,00/);
    expect(text).toMatch(/Comanda 14\s+-R\$ 15,00/);
  });
});
