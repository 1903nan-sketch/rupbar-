/**
 * Relatório completo em PDF (A4): cabeçalho, quadros de resumo e as tabelas
 * de cada parte (recebimentos, produtos, descontos, cancelamentos, caixa…).
 */
import { formatBRL } from './money';
import { PdfDoc, type Rgb } from './pdf';
import { BAR_TIME_ZONE, paymentLabel, reportTitle, reportTotals, reportWindowLabel, type FullReport } from './report';

export { PdfDoc, winAnsi } from './pdf';

const INK: Rgb = [17, 24, 39];
const MUTED: Rgb = [107, 114, 128];
const LINE: Rgb = [229, 231, 235];
const ZEBRA: Rgb = [248, 250, 252];
const HEAD_BG: Rgb = [241, 245, 249];
const BAND: Rgb = [24, 32, 56];
const ACCENT: Rgb = [37, 99, 235];
const RED: Rgb = [185, 28, 28];
const ORANGE: Rgb = [180, 83, 9];

const M = 36; // margem
const BOTTOM = 52; // espaço do rodapé

type Align = 'left' | 'right';
interface Col {
  title: string;
  /** Fração da largura útil. */
  w: number;
  align?: Align;
  /** Coluna com barra proporcional (0–1) antes do valor. */
  bar?: boolean;
}
type Cell = string | { text: string; color?: Rgb; bold?: boolean; bar?: number };

const dt = (iso: string | null, opts: Intl.DateTimeFormatOptions) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { ...opts, timeZone: BAR_TIME_ZONE }) : '—';
const dmhm = (iso: string | null) => dt(iso, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '—');

class ReportLayout {
  readonly doc = new PdfDoc();
  y = 0;
  readonly inner = this.doc.width - M * 2;

  constructor(readonly footer: string) {}

  newPage(): void {
    this.doc.addPage();
    this.y = M;
  }

  ensure(h: number): boolean {
    if (this.y + h <= this.doc.height - BOTTOM) return false;
    this.newPage();
    return true;
  }

  section(title: string, note?: string): void {
    this.ensure(60);
    this.y += 14;
    this.doc.rect(M, this.y - 10, 3, 13, ACCENT);
    this.doc.text(M + 9, this.y, title, { size: 11.5, bold: true });
    if (note) this.doc.text(M + this.inner, this.y, note, { size: 7.5, color: MUTED, align: 'right', maxWidth: this.inner * 0.55 });
    this.y += 8;
  }

  private header(cols: Col[]): void {
    const d = this.doc;
    d.rect(M, this.y, this.inner, 15, HEAD_BG);
    let x = M;
    for (const c of cols) {
      const w = c.w * this.inner;
      d.text(c.align === 'right' ? x + w - 5 : x + 5, this.y + 10.5, c.title.toUpperCase(), { size: 6.8, bold: true, color: MUTED, align: c.align ?? 'left', maxWidth: w - 8 });
      x += w;
    }
    this.y += 15;
  }

  table(cols: Col[], rows: Cell[][], title?: string, foot?: Cell[]): void {
    const d = this.doc;
    const rowH = 14.5;
    this.ensure(15 + rowH * Math.min(rows.length, 2) + 4);
    this.header(cols);
    const draw = (row: Cell[], i: number, strong = false) => {
      if (this.ensure(rowH)) {
        if (title) {
          this.y += 10;
          d.text(M, this.y, `${title} (continuação)`, { size: 8.5, bold: true, color: MUTED });
          this.y += 6;
        }
        this.header(cols);
      }
      if (strong) d.rect(M, this.y, this.inner, rowH, HEAD_BG);
      else if (i % 2 === 1) d.rect(M, this.y, this.inner, rowH, ZEBRA);
      let x = M;
      cols.forEach((c, k) => {
        const w = c.w * this.inner;
        const cell = row[k] ?? '';
        const o = typeof cell === 'string' ? { text: cell } : cell;
        if (c.bar && o.bar !== undefined) {
          const bw = Math.max(0, Math.min(1, o.bar)) * (w * 0.45);
          d.rect(x + 5, this.y + 4.5, Math.max(bw, o.bar > 0 ? 1.5 : 0), 5.5, [191, 219, 254]);
        }
        d.text(c.align === 'right' ? x + w - 5 : x + 5, this.y + 10.2, o.text, {
          size: 8.4, bold: strong || o.bold, color: o.color ?? INK, align: c.align ?? 'left', maxWidth: w - 9,
        });
        x += w;
      });
      this.y += rowH;
    };
    rows.forEach((r, i) => draw(r, i));
    if (foot) draw(foot, 0, true);
    d.line(M, this.y, M + this.inner, this.y, LINE);
    this.y += 4;
  }

  empty(text: string): void {
    this.ensure(18);
    this.doc.text(M + 2, this.y + 10, text, { size: 8.5, color: MUTED });
    this.y += 16;
  }

  finish(title: string): Uint8Array {
    const n = this.doc.pageCount;
    for (let p = 0; p < n; p++) {
      const y = this.doc.height - 26;
      this.doc.line(M, y - 11, M + this.inner, y - 11, LINE, 0.5, p);
      this.doc.text(M, y, this.footer, { size: 7, color: MUTED, maxWidth: this.inner - 80 }, p);
      this.doc.text(M + this.inner, y, `Página ${p + 1} de ${n}`, { size: 7, color: MUTED, align: 'right' }, p);
    }
    return this.doc.build(title);
  }
}

/** O relatório inteiro em PDF. */
export function renderReportPdf(r: FullReport): Uint8Array {
  const s = r.summary;
  const t = reportTotals(r);
  const period = reportTitle(r.de, r.ate);
  const L = new ReportLayout(`RupBar · ${r.barName} · Relatório de vendas · ${period}`);
  const d = L.doc;
  L.newPage();

  // Cabeçalho
  d.rect(0, 0, d.width, 92, BAND);
  d.text(M, 38, r.barName, { size: 19, bold: true, color: [255, 255, 255], maxWidth: L.inner });
  d.text(M, 58, `Relatório de vendas · ${period}`, { size: 11.5, color: [226, 232, 240], maxWidth: L.inner });
  d.text(M, 75, `${reportWindowLabel(r.de, r.ate)} · gerado em ${dmhm(r.generatedAt)}`, { size: 8, color: [148, 163, 184], maxWidth: L.inner });
  L.y = 108;

  // Quadros de resumo (2 linhas × 4)
  const boxes: [string, string, string?, Rgb?][] = [
    ['Vendido (itens)', formatBRL(s.grossCents), `${s.itemsSold} ${s.itemsSold === 1 ? 'item' : 'itens'}`],
    ['Descontos', s.discountsCents ? `− ${formatBRL(s.discountsCents)}` : formatBRL(0), s.serviceFeeCents ? `taxa de serviço + ${formatBRL(s.serviceFeeCents)}` : undefined, s.discountsCents ? ORANGE : undefined],
    ['Líquido', formatBRL(t.netCents), 'vendido − descontos + taxa'],
    ['Recebido', formatBRL(s.receivedCents), 'pagamentos no período', ACCENT],
    ['Custo estimado', formatBRL(s.costCents), 'do que saiu do estoque'],
    ['Lucro bruto', formatBRL(t.marginCents), `margem ${t.marginPct}%`],
    ['Atendimentos', String(t.tickets), `${s.closedComandas} comandas · ${s.quickSales} vendas rápidas`],
    ['Ticket médio', formatBRL(t.averageTicketCents), 'recebido ÷ atendimentos'],
  ];
  const gap = 8;
  const bw = (L.inner - gap * 3) / 4;
  const bh = 50;
  boxes.forEach(([label, value, hint, c], i) => {
    const x = M + (i % 4) * (bw + gap);
    const y = L.y + Math.floor(i / 4) * (bh + gap);
    d.rect(x, y, bw, bh, [248, 250, 252]);
    d.line(x, y, x + bw, y, LINE, 0.5);
    d.text(x + 8, y + 14, label.toUpperCase(), { size: 6.6, bold: true, color: MUTED, maxWidth: bw - 14 });
    d.text(x + 8, y + 31, value, { size: 13.5, bold: true, color: c ?? INK, maxWidth: bw - 14 });
    if (hint) d.text(x + 8, y + 43, hint, { size: 6.6, color: MUTED, maxWidth: bw - 14 });
  });
  L.y += bh * 2 + gap + 10;

  const facts = [
    s.canceledCents ? `Cancelados: ${formatBRL(s.canceledCents)}` : null,
    s.reversedCents ? `Estornos: ${formatBRL(s.reversedCents)}` : null,
    s.canceledComandas ? `Comandas canceladas: ${s.canceledComandas}` : null,
    s.staffCents ? `Consumo de funcionários: ${formatBRL(s.staffCents)} (fora das vendas)` : null,
    s.lossesCents ? `Perdas: ${formatBRL(s.lossesCents)}` : null,
    r.hookah.sessions ? `Narguilés: ${r.hookah.sessions} (${formatBRL(r.hookah.totalCents)})` : null,
    s.stillOpen ? `Ainda abertas: ${s.stillOpen} comanda${s.stillOpen === 1 ? '' : 's'} (${formatBRL(s.stillOpenCents)})` : null,
  ].filter(Boolean) as string[];
  // Fatos do período em linhas que quebram entre um item e outro.
  const lines: string[] = [];
  for (const f of facts) {
    const last = lines[lines.length - 1];
    if (last !== undefined && d.measure(`${last}   ·   ${f}`, 7.8) <= L.inner) lines[lines.length - 1] = `${last}   ·   ${f}`;
    else lines.push(f);
  }
  for (const l of lines) {
    d.text(M, L.y, l, { size: 7.8, color: MUTED, maxWidth: L.inner });
    L.y += 11;
  }

  // Recebimentos
  L.section('Recebimentos por forma de pagamento');
  if (r.payments.length) {
    L.table(
      [{ title: 'Forma', w: 0.4 }, { title: 'Pagamentos', w: 0.2, align: 'right' }, { title: '% do recebido', w: 0.2, align: 'right' }, { title: 'Valor', w: 0.2, align: 'right' }],
      r.payments.map((p) => [paymentLabel(p.method), String(p.count), pct(p.totalCents, s.receivedCents), formatBRL(p.totalCents)]),
      'Recebimentos',
      ['Total', String(r.payments.reduce((a, p) => a + p.count, 0)), '', formatBRL(s.receivedCents)],
    );
  } else L.empty('Nenhum pagamento no período.');

  // Por hora (um dia) ou por dia (período)
  if (r.de === r.ate) {
    const max = Math.max(1, ...r.byHour.map((h) => h.totalCents));
    if (r.byHour.length) {
      L.section('Vendas por hora');
      L.table(
        [{ title: 'Hora', w: 0.2 }, { title: '', w: 0.55, bar: true }, { title: 'Valor', w: 0.25, align: 'right' }],
        r.byHour.map((h) => [`${String(h.hour).padStart(2, '0')}h`, { text: '', bar: h.totalCents / max }, formatBRL(h.totalCents)]),
        'Vendas por hora',
      );
    }
  } else if (r.byDay.length) {
    const max = Math.max(1, ...r.byDay.map((x) => x.totalCents));
    L.section('Vendas por dia', 'o dia do bar vai das 05:00 às 05:00');
    L.table(
      [{ title: 'Dia', w: 0.22 }, { title: '', w: 0.36, bar: true }, { title: 'Custo', w: 0.2, align: 'right' }, { title: 'Vendido', w: 0.22, align: 'right' }],
      r.byDay.map((x) => [reportTitle(x.day, x.day).replace(/-feira/, ''), { text: '', bar: x.totalCents / max }, formatBRL(x.costCents), formatBRL(x.totalCents)]),
      'Vendas por dia',
    );
  }

  if (r.byCategory.length) {
    L.section('Por categoria');
    L.table(
      [{ title: 'Categoria', w: 0.36 }, { title: 'Qtd.', w: 0.12, align: 'right' }, { title: 'Custo', w: 0.17, align: 'right' }, { title: 'Margem', w: 0.13, align: 'right' }, { title: 'Vendido', w: 0.22, align: 'right' }],
      r.byCategory.map((c) => [c.category, String(c.qty), formatBRL(c.costCents), pct(c.totalCents - c.costCents, c.totalCents), formatBRL(c.totalCents)]),
      'Por categoria',
    );
  }

  L.section('Produtos vendidos', `${r.products.length} produto${r.products.length === 1 ? '' : 's'}`);
  if (r.products.length) {
    L.table(
      [{ title: 'Produto', w: 0.44 }, { title: 'Qtd.', w: 0.1, align: 'right' }, { title: 'Custo', w: 0.15, align: 'right' }, { title: 'Margem', w: 0.11, align: 'right' }, { title: 'Vendido', w: 0.2, align: 'right' }],
      r.products.map((p) => [
        p.presentation && p.presentation !== 'Unidade' && p.presentation.toLowerCase() !== p.name.toLowerCase() ? `${p.name} · ${p.presentation}` : p.name,
        String(p.qty), formatBRL(p.costCents), pct(p.totalCents - p.costCents, p.totalCents), formatBRL(p.totalCents),
      ]),
      'Produtos vendidos',
      ['Total', String(s.itemsSold), formatBRL(s.costCents), pct(t.marginCents, s.grossCents), formatBRL(s.grossCents)],
    );
  } else L.empty('Nenhum produto vendido no período.');

  if (r.byWaiter.length) {
    L.section('Por atendente', 'quem lançou os pedidos');
    L.table(
      [{ title: 'Atendente', w: 0.5 }, { title: 'Pedidos', w: 0.2, align: 'right' }, { title: 'Lançado', w: 0.3, align: 'right' }],
      r.byWaiter.map((w) => [w.name, String(w.orders), formatBRL(w.totalCents)]),
      'Por atendente',
    );
  }

  L.section('Descontos', r.discounts.length ? `${formatBRL(s.discountsCents)} no total` : undefined);
  if (r.discounts.length) {
    L.table(
      [{ title: 'Comanda', w: 0.16 }, { title: 'Cliente', w: 0.18 }, { title: 'Motivo', w: 0.3 }, { title: 'Encerrada', w: 0.2 }, { title: 'Desconto', w: 0.16, align: 'right' }],
      r.discounts.map((x) => [x.comanda, x.customer ?? '—', x.reason ?? '—', `${dmhm(x.closedAt)}${x.closedBy ? ` · ${x.closedBy}` : ''}`, { text: `− ${formatBRL(x.discountCents)}`, color: ORANGE }]),
      'Descontos',
    );
  } else L.empty('Nenhum desconto no período.');

  L.section('Cancelamentos', r.cancellations.length ? `${formatBRL(s.canceledCents)} em itens` : undefined);
  if (r.cancellations.length) {
    L.table(
      [{ title: 'Quando', w: 0.14 }, { title: 'Item', w: 0.3 }, { title: 'Motivo', w: 0.26 }, { title: 'Por', w: 0.15 }, { title: 'Valor', w: 0.15, align: 'right' }],
      r.cancellations.map((c) => [dmhm(c.at), `${c.qty}× ${c.product}`, c.reason ?? '—', c.by ?? '—', { text: formatBRL(c.totalCents), color: RED }]),
      'Cancelamentos',
    );
  } else L.empty('Nenhum item cancelado no período.');

  if (r.staffConsumption.length) {
    L.section('Consumo de funcionários', 'não cobrado; fora das vendas');
    L.table(
      [{ title: 'Funcionário', w: 0.46 }, { title: 'Itens', w: 0.14, align: 'right' }, { title: 'Custo', w: 0.18, align: 'right' }, { title: 'Preço de cardápio', w: 0.22, align: 'right' }],
      r.staffConsumption.map((x) => [x.name, String(x.items), formatBRL(x.costCents), formatBRL(x.valueCents)]),
      'Consumo de funcionários',
    );
  }

  L.section('Caixas');
  if (r.cashSessions.length) {
    L.table(
      [
        { title: 'Caixa', w: 0.09 }, { title: 'Abertura', w: 0.2 }, { title: 'Fechamento', w: 0.2 }, { title: 'Troco', w: 0.12, align: 'right' },
        { title: 'Esperado', w: 0.13, align: 'right' }, { title: 'Contado', w: 0.13, align: 'right' }, { title: 'Diferença', w: 0.13, align: 'right' },
      ],
      r.cashSessions.map((c) => [
        `nº ${c.number}`,
        `${dmhm(c.openedAt)}${c.openedBy ? ` · ${c.openedBy}` : ''}`,
        c.status === 'open' ? 'aberto' : `${dmhm(c.closedAt)}${c.closedBy ? ` · ${c.closedBy}` : ''}`,
        formatBRL(c.openingCents),
        c.expectedCents === null ? '—' : formatBRL(c.expectedCents),
        c.countedCents === null ? '—' : formatBRL(c.countedCents),
        c.differenceCents === null ? '—' : { text: formatBRL(c.differenceCents), color: c.differenceCents < 0 ? RED : c.differenceCents > 0 ? ORANGE : INK, bold: c.differenceCents !== 0 },
      ]),
      'Caixas',
    );
  } else L.empty('Nenhum caixa aberto no período.');

  if (r.cashMovements.length) {
    L.section('Sangrias e suprimentos');
    L.table(
      [{ title: 'Quando', w: 0.15 }, { title: 'Tipo', w: 0.15 }, { title: 'Motivo', w: 0.38 }, { title: 'Por', w: 0.16 }, { title: 'Valor', w: 0.16, align: 'right' }],
      r.cashMovements.map((m) => [dmhm(m.at), m.type === 'withdrawal' ? 'Sangria' : 'Suprimento', m.reason, m.by ?? '—', `${m.type === 'withdrawal' ? '− ' : '+ '}${formatBRL(m.amountCents)}`]),
      'Sangrias e suprimentos',
    );
  }

  if (r.losses.length) {
    L.section('Perdas', `${formatBRL(s.lossesCents)} de custo`);
    L.table(
      [{ title: 'Produto', w: 0.42 }, { title: 'Motivo', w: 0.28 }, { title: 'Vezes', w: 0.12, align: 'right' }, { title: 'Custo', w: 0.18, align: 'right' }],
      r.losses.map((l) => [l.product, l.reason, String(l.count), formatBRL(l.costCents)]),
      'Perdas',
    );
  }

  return L.finish(`Relatório de vendas · ${r.barName} · ${period}`);
}
