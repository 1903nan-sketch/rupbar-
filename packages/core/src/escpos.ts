/**
 * Codificador ESC/POS puro (sem dependências), compatível com a maioria das
 * impressoras térmicas de 58 mm e 80 mm usadas em bares (Epson, Elgin, Bematech
 * em modo ESC/POS, Tanca, Knup e genéricas).
 *
 * Produz bytes; o transporte (rede TCP 9100, spooler do Windows, arquivo) fica
 * no servidor local.
 */

import { formatBRL } from './money';

export type PaperWidth = 58 | 80;
export type CodePage = 'cp850' | 'cp860' | 'ascii';

export const COLUMNS: Record<PaperWidth, number> = { 58: 32, 80: 48 };

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const CODEPAGE_SELECT: Record<Exclude<CodePage, 'ascii'>, number> = { cp850: 2, cp860: 3 };

const CP850: Record<string, number> = {
  á: 0xa0, à: 0x85, â: 0x83, ã: 0xc6, ä: 0x84, é: 0x82, è: 0x8a, ê: 0x88, ë: 0x89, í: 0xa1, ì: 0x8d, î: 0x8c,
  ó: 0xa2, ò: 0x95, ô: 0x93, õ: 0xe4, ö: 0x94, ú: 0xa3, ù: 0x97, û: 0x96, ü: 0x81, ç: 0x87, ñ: 0xa4,
  Á: 0xb5, À: 0xb7, Â: 0xb6, Ã: 0xc7, Ä: 0x8e, É: 0x90, Ê: 0xd2, È: 0xd4, Í: 0xd6, Ó: 0xe0, Ô: 0xe2, Õ: 0xe5,
  Ö: 0x99, Ú: 0xe9, Ü: 0x9a, Ç: 0x80, Ñ: 0xa5, º: 0xa7, ª: 0xa6, '°': 0xf8,
};

const CP860: Record<string, number> = {
  á: 0xa0, à: 0x85, â: 0x83, ã: 0x84, é: 0x82, ê: 0x88, è: 0x8a, í: 0xa1, ì: 0x8d, ó: 0xa2, ô: 0x93, õ: 0x94,
  ò: 0x95, ú: 0xa3, ù: 0x97, ü: 0x81, ç: 0x87, ñ: 0xa4,
  Á: 0x86, À: 0x91, Â: 0x8f, Ã: 0x8e, É: 0x90, Ê: 0x89, È: 0x92, Í: 0x8b, Ì: 0x98, Ó: 0x9f, Ô: 0x8c, Õ: 0x99,
  Ò: 0xa9, Ú: 0x96, Ù: 0x9d, Ü: 0x9a, Ç: 0x80, Ñ: 0xa5, º: 0xa7, ª: 0xa6, '°': 0xf8,
};

/** Remove acentos: "Ação" → "Acao". */
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function encodeText(text: string, codepage: CodePage): number[] {
  const table = codepage === 'cp850' ? CP850 : codepage === 'cp860' ? CP860 : null;
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (code === 0x0a) out.push(LF);
    else if (code >= 0x20 && code < 0x7f) out.push(code);
    else if (table && table[ch] !== undefined) out.push(table[ch]!);
    else {
      const plain = stripDiacritics(ch);
      const c = plain.codePointAt(0) ?? 0x3f;
      // Caracteres de controle e símbolos fora da tabela viram espaço/interrogação
      out.push(c >= 0x20 && c < 0x7f ? c : ch === ' ' ? 0x20 : 0x3f);
    }
  }
  return out;
}

/** Comprimento visual (1 coluna por caractere). */
function len(s: string): number {
  return Array.from(s.normalize('NFC')).length;
}

export function padRight(s: string, width: number): string {
  const l = len(s);
  return l >= width ? Array.from(s).slice(0, width).join('') : s + ' '.repeat(width - l);
}

export function padLeft(s: string, width: number): string {
  const l = len(s);
  return l >= width ? Array.from(s).slice(0, width).join('') : ' '.repeat(width - l) + s;
}

/** Quebra o texto em linhas de no máximo `width` colunas, respeitando palavras. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (len(word) > width) {
        if (line) lines.push(line);
        const chars = Array.from(word);
        for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''));
        line = lines.pop() ?? '';
        continue;
      }
      if (!line) line = word;
      else if (len(line) + 1 + len(word) <= width) line += ' ' + word;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** "Item ............ R$ 10,00" em uma linha; o texto da esquerda é truncado se necessário. */
export function twoColumns(left: string, right: string, width: number): string {
  const r = len(right);
  const space = Math.max(1, width - r);
  return padRight(left, space - 1) + ' ' + right;
}

export class EscPosBuilder {
  private bytes: number[] = [];
  readonly columns: number;

  constructor(
    readonly paper: PaperWidth = 80,
    readonly codepage: CodePage = 'cp850',
  ) {
    this.columns = COLUMNS[paper];
    this.raw([ESC, 0x40]); // inicializa
    if (codepage !== 'ascii') this.raw([ESC, 0x74, CODEPAGE_SELECT[codepage]]);
  }

  raw(data: number[]): this {
    for (const b of data) this.bytes.push(b & 0xff);
    return this;
  }

  text(s: string): this {
    return this.raw(encodeText(s, this.codepage));
  }

  line(s = ''): this {
    return this.text(s).raw([LF]);
  }

  align(a: 'left' | 'center' | 'right'): this {
    return this.raw([ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2]);
  }

  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  /** Tamanho do caractere: 1 = normal, 2 = dobro. */
  size(width: 1 | 2, height: 1 | 2): this {
    return this.raw([GS, 0x21, ((width - 1) << 4) | (height - 1)]);
  }

  separator(ch = '-'): this {
    return this.line(ch.repeat(this.columns));
  }

  /** Linhas com quebra automática considerando o tamanho atual de fonte. */
  wrapped(s: string, scale: 1 | 2 = 1): this {
    for (const l of wrap(s, Math.floor(this.columns / scale))) this.line(l);
    return this;
  }

  pair(left: string, right: string): this {
    return this.line(twoColumns(left, right, this.columns));
  }

  feed(lines = 1): this {
    return this.raw([ESC, 0x64, Math.max(0, Math.min(255, lines))]);
  }

  /** Avança o papel e realiza corte parcial. */
  cut(): this {
    return this.feed(3).raw([GS, 0x56, 0x42, 0x00]);
  }

  /** Aciona a gaveta de dinheiro (pino 2). */
  openDrawer(): this {
    return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa]);
  }

  /** Bipe (suportado por parte das impressoras de cozinha). */
  beep(times = 2): this {
    return this.raw([ESC, 0x42, Math.min(9, times), 3]);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });
}

export interface PrintOptions {
  paper: PaperWidth;
  codepage: CodePage;
  beep?: boolean;
}

export interface OrderTicketData {
  barName: string;
  orderNumber: number;
  stationLabel: string;
  table: string | null;
  comandaNumber: number | null;
  /** Apenas o primeiro nome — nunca CPF ou telefone. */
  customerFirstName: string | null;
  waiterName: string | null;
  createdAt: Date;
  items: { quantity: number; name: string; notes?: string | null }[];
  notes?: string | null;
  reprint?: boolean;
}

/** Cupom de produção (cozinha ou balcão). */
export function renderOrderTicket(data: OrderTicketData, opts: PrintOptions): Uint8Array {
  const p = new EscPosBuilder(opts.paper, opts.codepage);
  if (opts.beep) p.beep(2);
  p.align('center').bold(true).wrapped(data.barName).bold(false);
  p.line(data.stationLabel.toUpperCase());
  if (data.reprint) p.bold(true).line('*** REIMPRESSÃO ***').bold(false);
  p.size(2, 2).bold(true).line(`PEDIDO ${data.orderNumber}`).size(1, 1).bold(false);
  p.align('left').separator();
  if (data.table) p.size(1, 2).line(`Mesa: ${data.table}`).size(1, 1);
  if (data.comandaNumber !== null) p.line(`Comanda: ${data.comandaNumber}`);
  if (data.customerFirstName) p.line(`Cliente: ${data.customerFirstName}`);
  if (data.waiterName) p.line(`Atendente: ${data.waiterName}`);
  p.line(`Horário: ${fmtTime(data.createdAt)}`);
  p.separator();
  for (const item of data.items) {
    p.bold(true).size(1, 2);
    const head = `${item.quantity}x `;
    const lines = wrap(item.name, p.columns - head.length);
    lines.forEach((l, i) => p.line((i === 0 ? head : ' '.repeat(head.length)) + l));
    p.size(1, 1).bold(false);
    if (item.notes) for (const l of wrap(`> ${item.notes}`, p.columns - 2)) p.line('  ' + l);
  }
  if (data.notes) {
    p.separator();
    p.bold(true).line('OBSERVAÇÕES:').bold(false).wrapped(data.notes);
  }
  p.separator();
  p.align('center').line(fmtDateTime(data.createdAt));
  return p.cut().build();
}

export interface BillReceiptData {
  barName: string;
  headerLines?: string[];
  comandaNumber: number;
  table: string | null;
  customerFirstName: string | null;
  openedAt: Date;
  printedAt: Date;
  items: { quantity: number; name: string; total: number }[];
  subtotal: number;
  discount: number;
  serviceFee: number;
  total: number;
  payments: { label: string; amount: number }[];
  remaining: number;
}

/** Conferência de conta (não fiscal). */
export function renderBillReceipt(data: BillReceiptData, opts: PrintOptions): Uint8Array {
  const p = new EscPosBuilder(opts.paper, opts.codepage);
  p.align('center').bold(true).size(1, 2).wrapped(data.barName).size(1, 1).bold(false);
  for (const h of data.headerLines ?? []) p.wrapped(h);
  p.line('CONFERÊNCIA DE CONTA').line('NÃO É DOCUMENTO FISCAL');
  p.align('left').separator();
  p.line(`Comanda ${data.comandaNumber}${data.table ? ` — Mesa ${data.table}` : ''}`);
  if (data.customerFirstName) p.line(`Cliente: ${data.customerFirstName}`);
  p.line(`Abertura: ${fmtDateTime(data.openedAt)}`);
  p.separator();
  for (const it of data.items) {
    p.pair(`${it.quantity}x ${it.name}`, formatBRL(it.total));
  }
  p.separator();
  p.pair('Subtotal', formatBRL(data.subtotal));
  if (data.discount) p.pair('Desconto', '-' + formatBRL(data.discount));
  if (data.serviceFee) p.pair('Taxa de serviço', formatBRL(data.serviceFee));
  p.bold(true).size(1, 2).pair('TOTAL', formatBRL(data.total)).size(1, 1).bold(false);
  if (data.payments.length) {
    p.separator();
    for (const pay of data.payments) p.pair(pay.label, formatBRL(pay.amount));
    p.bold(true).pair('A pagar', formatBRL(Math.max(0, data.remaining))).bold(false);
  }
  p.separator();
  p.align('center').line(fmtDateTime(data.printedAt)).line('RupBar by Ruptix');
  return p.cut().build();
}

export interface CashCloseData {
  barName: string;
  sessionLabel: string;
  openedBy: string;
  openedAt: Date;
  closedBy: string;
  closedAt: Date;
  openingBalance: number;
  byMethod: { label: string; amount: number }[];
  withdrawals: number;
  supplies: number;
  expectedCash: number;
  countedCash: number;
  difference: number;
}

export function renderCashClose(data: CashCloseData, opts: PrintOptions): Uint8Array {
  const p = new EscPosBuilder(opts.paper, opts.codepage);
  p.align('center').bold(true).wrapped(data.barName).line('FECHAMENTO DE CAIXA').bold(false);
  p.line(data.sessionLabel);
  p.align('left').separator();
  p.line(`Abertura: ${fmtDateTime(data.openedAt)}`).wrapped(`por ${data.openedBy}`);
  p.line(`Fechamento: ${fmtDateTime(data.closedAt)}`).wrapped(`por ${data.closedBy}`);
  p.separator();
  p.pair('Saldo inicial', formatBRL(data.openingBalance));
  for (const m of data.byMethod) p.pair(m.label, formatBRL(m.amount));
  p.pair('Suprimentos', formatBRL(data.supplies));
  p.pair('Sangrias', '-' + formatBRL(data.withdrawals));
  p.separator();
  p.pair('Dinheiro esperado', formatBRL(data.expectedCash));
  p.pair('Dinheiro contado', formatBRL(data.countedCash));
  p.bold(true).pair(data.difference < 0 ? 'FALTA' : data.difference > 0 ? 'SOBRA' : 'DIFERENÇA', formatBRL(Math.abs(data.difference))).bold(false);
  p.feed(2).line('Assinatura: ______________________');
  return p.cut().build();
}

export function renderTestPage(barName: string, printerName: string, opts: PrintOptions): Uint8Array {
  const p = new EscPosBuilder(opts.paper, opts.codepage);
  p.align('center').bold(true).size(2, 2).line('RupBar').size(1, 1).bold(false);
  p.wrapped(barName).line(`Impressora: ${printerName}`);
  p.line(`Papel ${opts.paper} mm — ${p.columns} colunas`);
  p.separator('=');
  p.align('left').line('Acentuação: ÁÉÍÓÚ áéíóú ãõ ç Ç â ê ô');
  p.line('0123456789'.repeat(Math.ceil(p.columns / 10)).slice(0, p.columns));
  p.bold(true).line('Negrito').bold(false).size(1, 2).line('Altura dupla').size(1, 1);
  p.align('center').line(fmtDateTime(new Date())).line('Teste concluído');
  return p.cut().build();
}
