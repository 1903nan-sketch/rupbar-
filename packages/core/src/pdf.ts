/**
 * PDF mínimo, sem dependências: páginas A4 com texto (Helvetica, acentos do
 * português pela codificação WinAnsi), linhas e retângulos. Usado pelo PC do
 * bar e pelo painel online para o relatório em PDF.
 */

// Larguras (1/1000 em) dos caracteres 32–126 das fontes padrão do PDF.
const REGULAR_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Caracteres do Windows-1252 entre 0x80 e 0x9F. */
const CP1252: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const REPLACE: Record<string, string> = { '−': '-', '→': '>', '←': '<', ' ': ' ', ' ': ' ', ' ': ' ', '✓': 'v' };
const SPECIAL_WIDTH: Record<number, number> = {
  0x80: 556, 0x82: 222, 0x83: 556, 0x84: 333, 0x85: 1000, 0x86: 556, 0x87: 556, 0x88: 333, 0x89: 1000, 0x8a: 667, 0x8b: 333, 0x8c: 1000,
  0x8e: 611, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x98: 333, 0x99: 1000, 0x9a: 500, 0x9b: 333,
  0x9c: 944, 0x9e: 500, 0x9f: 667, 0xa0: 278, 0xa1: 333, 0xa2: 556, 0xa3: 556, 0xa4: 556, 0xa5: 556, 0xa6: 260, 0xa7: 556, 0xa8: 333,
  0xa9: 737, 0xaa: 370, 0xab: 556, 0xac: 584, 0xad: 333, 0xae: 737, 0xaf: 333, 0xb0: 400, 0xb1: 584, 0xb2: 333, 0xb3: 333, 0xb4: 333,
  0xb5: 556, 0xb6: 537, 0xb7: 278, 0xb8: 333, 0xb9: 333, 0xba: 365, 0xbb: 556, 0xbc: 834, 0xbd: 834, 0xbe: 834, 0xbf: 611, 0xc6: 1000,
  0xd0: 722, 0xd7: 584, 0xd8: 778, 0xde: 667, 0xdf: 611, 0xe6: 889, 0xf0: 556, 0xf7: 584, 0xf8: 611, 0xfe: 556,
};
/** Letras acentuadas: mesma largura da letra sem acento. */
function baseLetter(code: number): number {
  const ch = String.fromCharCode(code).normalize('NFD').charCodeAt(0);
  return ch >= 32 && ch <= 126 ? ch : 0;
}

function widthTable(ascii: number[]): number[] {
  const t = new Array<number>(256).fill(556);
  for (let c = 32; c <= 126; c++) t[c] = ascii[c - 32]!;
  for (let c = 128; c <= 255; c++) {
    const base = baseLetter(c);
    t[c] = SPECIAL_WIDTH[c] ?? (base ? t[base]! : 556);
  }
  return t;
}
const WIDTHS = { regular: widthTable(REGULAR_ASCII), bold: widthTable(BOLD_ASCII) };

/** Texto → bytes WinAnsi (o que não existe vira "?"). */
export function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const raw of s) {
    const ch = REPLACE[raw] ?? raw;
    for (const c of ch) {
      const code = c.codePointAt(0)!;
      if (code === 10 || code === 13 || code === 9) out.push(32);
      else if (code >= 32 && code <= 126) out.push(code);
      else if (code >= 0xa0 && code <= 0xff) out.push(code);
      else if (CP1252[c] !== undefined) out.push(CP1252[c]!);
      else if (code < 32) continue;
      else out.push(63);
    }
  }
  return out;
}

function pdfString(bytes: number[]): string {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}

export type Rgb = [number, number, number];
const num = (n: number) => (Math.round(n * 100) / 100).toString();
const color = (c: Rgb) => c.map((v) => num(v / 255)).join(' ');

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  align?: 'left' | 'right' | 'center';
  /** Corta com "…" para caber. */
  maxWidth?: number;
}

/** Documento com coordenadas a partir do canto superior esquerdo (em pontos). */
export class PdfDoc {
  readonly width = 595.28;
  readonly height = 841.89;
  private pages: string[][] = [];

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): number {
    this.pages.push([]);
    return this.pages.length - 1;
  }

  private out(op: string, page = this.pages.length - 1): void {
    if (!this.pages.length) this.addPage();
    this.pages[page < 0 ? 0 : page]!.push(op);
  }

  measure(s: string, size = 10, bold = false): number {
    const t = bold ? WIDTHS.bold : WIDTHS.regular;
    return (winAnsi(s).reduce((a, b) => a + t[b]!, 0) * size) / 1000;
  }

  /** Corta o texto com "…" para caber na largura. */
  fit(s: string, maxWidth: number, size = 10, bold = false): string {
    if (this.measure(s, size, bold) <= maxWidth) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.measure(s.slice(0, mid).trimEnd() + '…', size, bold) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo ? s.slice(0, lo).trimEnd() + '…' : '';
  }

  /** Texto com a linha de base em y. */
  text(x: number, y: number, s: string, o: TextOptions = {}, page?: number): void {
    const size = o.size ?? 10;
    const bold = o.bold ?? false;
    const str = o.maxWidth ? this.fit(s, o.maxWidth, size, bold) : s;
    if (!str) return;
    const w = this.measure(str, size, bold);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.out(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${color(o.color ?? [17, 24, 39])} rg ${num(left)} ${num(this.height - y)} Td ${pdfString(winAnsi(str))} Tj ET`, page);
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb, page?: number): void {
    this.out(`${color(fill)} rg ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`, page);
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: Rgb = [209, 213, 219], width = 0.6, page?: number): void {
    this.out(`${color(stroke)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`, page);
  }

  build(title: string): Uint8Array {
    if (!this.pages.length) this.addPage();
    const objs: string[] = [];
    const n = this.pages.length;
    const pageIds = Array.from({ length: n }, (_, i) => 6 + i * 2);
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${n} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    objs[5] = `<< /Title ${pdfString(winAnsi(title))} /Producer (RupBar) >>`;
    this.pages.forEach((ops, i) => {
      const content = ops.join('\n');
      objs[pageIds[i]!] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
      objs[pageIds[i]! + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });
    let body = '%PDF-1.4\n%âãÏÓ\n';
    const offsets: number[] = [];
    // Tudo é ASCII depois do cabeçalho; os 4 bytes binários do comentário contam 2 cada em UTF-8.
    const header = new TextEncoder().encode(body).length;
    let pos = header;
    let rest = '';
    for (let id = 1; id < objs.length; id++) {
      offsets[id] = pos;
      const chunk = `${id} 0 obj\n${objs[id]}\nendobj\n`;
      rest += chunk;
      pos += chunk.length;
    }
    const xref = pos;
    rest += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) rest += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    rest += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    body += rest;
    return new TextEncoder().encode(body);
  }
}
