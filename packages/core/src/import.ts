/**
 * Importação de produtos e contagem de estoque por planilha (CSV).
 *
 * Uma linha por produto, com colunas em português. Quantidades saem em
 * milésimos (ml, g ou unidades × 1000) e valores em centavos, como no resto do
 * sistema. Tudo aqui é puro: o servidor valida de novo ao gravar.
 */
import type { Measure } from './units';

export type ImportBuy = 'unidade' | 'fardo' | 'garrafa' | 'pacote';

export interface ImportRow {
  /** Linha da planilha (a 1ª é o cabeçalho). */
  line: number;
  name: string;
  category: string | null;
  buy: ImportBuy;
  measure: Measure;
  /** Conteúdo de uma embalagem em milésimos (fardo de 12 = 12.000; garrafa de 1 L = 1.000.000). */
  packageQty: number;
  packageLabel: string | null;
  unitLabel: string | null;
  /** Saldo contado em milésimos; null = a planilha não informa (o estoque não muda). */
  stockQty: number | null;
  /** Custo de uma embalagem (fardo, garrafa, pacote) ou da unidade avulsa. */
  packageCostCents: number | null;
  minStock: number | null;
  barcode: string | null;
  code: string | null;
  /** Como vende: preço e quanto cada venda baixa (milésimos). Vazio = só ingrediente/adicional. */
  presentations: { name: string; priceCents: number; qty: number }[];
  warnings: string[];
}

export type ImportResult = { ok: true; row: ImportRow } | { ok: false; line: number; name: string; error: string };

/** Colunas da planilha, na ordem do modelo. */
export const IMPORT_COLUMNS = [
  'nome', 'categoria', 'como_compra', 'qtd_embalagem', 'nome_embalagem', 'nome_unidade',
  'estoque_embalagens', 'estoque_soltas', 'custo_embalagem', 'preco_venda', 'dose_ml', 'preco_garrafa',
  'estoque_minimo', 'codigo_barras', 'codigo',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** "Preço de venda" → "preco_de_venda" (minúsculas, sem acento, _ no lugar de espaço). */
export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Apelidos aceitos para cada coluna (planilhas feitas à mão). */
const ALIASES: Record<string, ImportColumn> = {
  produto: 'nome', nome_do_produto: 'nome', descricao: 'nome',
  grupo: 'categoria',
  tipo: 'como_compra', compra: 'como_compra', embalagem: 'como_compra',
  quantidade_embalagem: 'qtd_embalagem', tamanho: 'qtd_embalagem', unidades_por_embalagem: 'qtd_embalagem',
  // "Quantidade" sozinha: embalagens fechadas (num produto avulso, é o mesmo que unidades).
  quantidade: 'estoque_embalagens', qtd: 'estoque_embalagens', estoque: 'estoque_embalagens', contagem: 'estoque_embalagens',
  fechados: 'estoque_embalagens', fechadas: 'estoque_embalagens', embalagens: 'estoque_embalagens',
  soltos: 'estoque_soltas', soltas: 'estoque_soltas', avulsos: 'estoque_soltas', abertos: 'estoque_soltas',
  custo: 'custo_embalagem', custo_de_compra: 'custo_embalagem', valor_de_compra: 'custo_embalagem',
  preco: 'preco_venda', preco_de_venda: 'preco_venda', valor_de_venda: 'preco_venda', valor: 'preco_venda',
  preco_dose: 'preco_venda', preco_da_dose: 'preco_venda',
  dose: 'dose_ml', ml_dose: 'dose_ml', dose_em_ml: 'dose_ml', tamanho_da_dose: 'dose_ml',
  preco_garrafa_fechada: 'preco_garrafa', preco_fechada: 'preco_garrafa', preco_pacote: 'preco_garrafa', preco_pacote_fechado: 'preco_garrafa',
  minimo: 'estoque_minimo', estoque_min: 'estoque_minimo',
  codigo_de_barras: 'codigo_barras', barras: 'codigo_barras', ean: 'codigo_barras', gtin: 'codigo_barras', codigo_interno: 'codigo',
};

export function columnOf(header: string): ImportColumn | null {
  const h = normalizeHeader(header);
  if ((IMPORT_COLUMNS as readonly string[]).includes(h)) return h as ImportColumn;
  return ALIASES[h] ?? null;
}

/** CSV do Excel brasileiro (;), do Google Planilhas (,) ou com tabulação; aspas e quebras de linha dentro de aspas. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const sep = count('\t') > count(';') && count('\t') > count(',') ? '\t' : count(';') >= count(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Planilha → registros por coluna conhecida. Colunas desconhecidas são ignoradas. */
export function csvRecords(text: string): { records: Partial<Record<ImportColumn, string>>[]; columns: ImportColumn[]; unknown: string[] } {
  const [head = [], ...body] = parseCsv(text);
  const cols = head.map(columnOf);
  const columns = cols.filter((c): c is ImportColumn => !!c);
  const unknown = head.filter((_, i) => !cols[i] && head[i]!.trim());
  const records = body.map((r) => {
    const rec: Partial<Record<ImportColumn, string>> = {};
    cols.forEach((c, i) => {
      if (c && r[i] !== undefined && r[i]!.trim() !== '') rec[c] = r[i]!.trim();
    });
    return rec;
  });
  return { records, columns, unknown };
}

/** Chave para achar o mesmo produto: sem acento, minúsculas e espaços simples. */
export function importNameKey(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** "1.234,56", "R$ 12,00", "12.5", "1.000" → número; vazio → null; inválido → NaN. */
export function parseImportNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.replace(/r\$/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

/** "1 L", "750 ml", "1,5l", "1 kg", "50 g", "12" → número na unidade base (ml ou g ou unidades). */
function parseSize(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*([\d.,]+)\s*(ml|l|lt|lts|litro|litros|g|gr|kg|un|unidades?)?\s*$/i.exec(raw);
  if (!m) return Number.NaN;
  const n = parseImportNumber(m[1]);
  if (n === null || Number.isNaN(n)) return Number.NaN;
  const unit = (m[2] ?? '').toLowerCase();
  return ['l', 'lt', 'lts', 'litro', 'litros', 'kg'].includes(unit) ? n * 1000 : n;
}

function buyOf(raw: string | undefined): ImportBuy | null {
  const s = normalizeHeader(raw ?? '');
  if (!s || ['unidade', 'un', 'avulso', 'avulsa', 'unitario'].includes(s)) return 'unidade';
  if (/^(fardo|caixa|cx|pack|engradado|display|bandeja)/.test(s)) return 'fardo';
  if (/^(garrafa|litro|ml|vidro|lata_grande)/.test(s)) return 'garrafa';
  if (/^(pacote|saco|pote|g|kg|grama)/.test(s)) return 'pacote';
  return null;
}

const money = (raw: string | undefined) => {
  const n = parseImportNumber(raw);
  return n === null ? null : Number.isNaN(n) ? Number.NaN : Math.round(n * 100);
};

const fmt = (n: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(n);

/** Converte uma linha da planilha em produto, embalagem, saldo e preços. */
export function mapImportRecord(rec: Partial<Record<ImportColumn, string>>, line: number): ImportResult {
  const name = (rec.nome ?? '').trim();
  const fail = (error: string): ImportResult => ({ ok: false, line, name, error });
  if (name.length < 2) return fail('Informe o nome do produto.');
  const buy = buyOf(rec.como_compra);
  if (!buy) return fail(`"Como compra" não reconhecido: "${rec.como_compra}". Use unidade, fardo, garrafa ou pacote.`);
  const warnings: string[] = [];

  const size = parseSize(rec.qtd_embalagem);
  if (size !== null && Number.isNaN(size)) return fail(`Quantidade da embalagem inválida: "${rec.qtd_embalagem}".`);
  let measure: Measure = 'unit';
  let packageQty = 1000;
  if (buy === 'fardo') {
    if (!size || size < 2 || !Number.isInteger(size)) return fail('Informe quantas unidades vêm no fardo/caixa (ex.: 12).');
    packageQty = size * 1000;
  } else if (buy === 'garrafa') {
    if (!size || size <= 0) return fail('Informe o tamanho da garrafa em ml (ex.: 1000 ou 1 L).');
    measure = 'volume';
    packageQty = Math.round(size * 1000);
  } else if (buy === 'pacote') {
    if (!size || size <= 0) return fail('Informe o peso do pacote em g (ex.: 50 ou 1 kg).');
    measure = 'mass';
    packageQty = Math.round(size * 1000);
  }
  const packageLabel = rec.nome_embalagem?.trim().toLowerCase() || (buy === 'unidade' ? null : buy === 'fardo' ? 'fardo' : buy);
  const unitLabel = rec.nome_unidade?.trim().toLowerCase() || (buy === 'fardo' ? 'unidade' : null);

  // Saldo: embalagens fechadas (aceita fração: 2,5 garrafas) + soltas (unidades, ml ou g).
  const packs = parseImportNumber(rec.estoque_embalagens);
  const loose = parseImportNumber(rec.estoque_soltas);
  if ((packs !== null && (Number.isNaN(packs) || packs < 0)) || (loose !== null && (Number.isNaN(loose) || loose < 0))) {
    return fail('Estoque inválido: use números (ex.: 3 fechados e 5 soltos).');
  }
  const stockQty = packs === null && loose === null ? null : Math.round((packs ?? 0) * packageQty + (loose ?? 0) * 1000);
  if (stockQty === null) warnings.push('Sem quantidade em estoque: o saldo não muda.');

  const packageCostCents = money(rec.custo_embalagem);
  if (packageCostCents !== null && (Number.isNaN(packageCostCents) || packageCostCents < 0)) return fail(`Custo inválido: "${rec.custo_embalagem}".`);
  const price = money(rec.preco_venda);
  if (price !== null && (Number.isNaN(price) || price < 0)) return fail(`Preço de venda inválido: "${rec.preco_venda}".`);
  const wholePrice = money(rec.preco_garrafa);
  if (wholePrice !== null && (Number.isNaN(wholePrice) || wholePrice < 0)) return fail(`Preço da garrafa/pacote fechado inválido: "${rec.preco_garrafa}".`);
  const dose = parseImportNumber(rec.dose_ml);
  if (dose !== null && (Number.isNaN(dose) || dose <= 0)) return fail(`Dose inválida: "${rec.dose_ml}".`);

  const presentations: ImportRow['presentations'] = [];
  if (buy === 'unidade' || buy === 'fardo') {
    if (price !== null) presentations.push({ name: 'Unidade', priceCents: price, qty: 1000 });
  } else {
    const unit = buy === 'garrafa' ? 'ml' : 'g';
    const closed = buy === 'garrafa' ? 'Garrafa fechada' : 'Pacote fechado';
    if (dose !== null) {
      if (dose * 1000 > packageQty) return fail(`A dose (${fmt(dose)} ${unit}) é maior que a embalagem.`);
      if (price !== null) presentations.push({ name: `${buy === 'garrafa' ? 'Dose' : 'Porção'} ${fmt(dose)} ${unit}`, priceCents: price, qty: Math.round(dose * 1000) });
      else warnings.push('Dose sem preço: informe o preço da dose.');
      if (wholePrice !== null) presentations.push({ name: closed, priceCents: wholePrice, qty: packageQty });
    } else if (price !== null || wholePrice !== null) {
      presentations.push({ name: closed, priceCents: (wholePrice ?? price)!, qty: packageQty });
    }
  }
  if (!presentations.length) warnings.push('Sem preço de venda: entra como ingrediente/adicional (fora do cardápio).');

  const min = parseImportNumber(rec.estoque_minimo);
  if (min !== null && (Number.isNaN(min) || min < 0)) return fail(`Estoque mínimo inválido: "${rec.estoque_minimo}".`);
  // Mínimo: em unidades (lata, unidade) ou em embalagens (garrafas, pacotes).
  const minStock = min === null ? null : Math.round(measure === 'unit' ? min * 1000 : min * packageQty);

  const barcode = rec.codigo_barras?.replace(/\s/g, '') || null;
  if (barcode && !/^[0-9A-Za-z-]{4,32}$/.test(barcode)) return fail(`Código de barras inválido: "${rec.codigo_barras}".`);

  return {
    ok: true,
    row: {
      line, name: name.slice(0, 80), category: rec.categoria?.trim().slice(0, 40) || null, buy, measure, packageQty, packageLabel, unitLabel,
      stockQty, packageCostCents, minStock, barcode, code: rec.codigo?.trim().slice(0, 30) || null, presentations, warnings,
    },
  };
}

/** Modelo para baixar e preencher (Excel abre direto). */
export function importTemplateCsv(): string {
  const rows = [
    IMPORT_COLUMNS as readonly string[],
    ['Heineken long neck', 'Cervejas', 'fardo', '24', 'fardo', 'long neck', '3', '5', '120,00', '12,00', '', '', '24', '7896045506873', ''],
    ['Gin Rocks Morango 1 L', 'Destilados', 'garrafa', '1000', 'garrafa', '', '2', '500', '90,00', '12,00', '50', '120,00', '1', '', ''],
    ['Ziggy Menta 50 g', 'Essências', 'pacote', '50', 'pacote', '', '6', '30', '25,00', '45,00', '', '', '2', '', ''],
    ['Red Bull Tropical lata', 'Energéticos', 'unidade', '', '', 'lata', '', '18', '7,50', '15,00', '', '', '6', '', ''],
    ['Gelo de coco', 'Outros', 'unidade', '', '', 'unidade', '', '40', '1,50', '', '', '', '10', '', ''],
  ];
  const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
