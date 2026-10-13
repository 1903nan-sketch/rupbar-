/**
 * Embalagem de compra × unidade de controle, em linguagem do dono do bar.
 *
 * O saldo continua guardado em milésimos da unidade-base (un, ml, g). Este
 * módulo apenas traduz para o que a pessoa vê no balcão:
 *
 *   - "2 fardos de 12"            = 24 latas      = 24_000
 *   - "1 garrafa de 1.000 ml"     = 20 doses de 50 = 1_000_000
 *   - "4 pacotes de 50 g"         = 200 g         = 200_000
 *
 * Também gera o código interno sequencial dos produtos (0001, 0002…).
 */
import type { Cents } from './money';
import type { Measure, QtyMilli } from './units';
import { MILLI } from './units';

/** Como o produto chega do fornecedor. */
export type BuyMode = 'single' | 'pack' | 'bottle' | 'bag';
/** Como o produto sai no balcão. */
export type SellMode = 'unit' | 'dose' | 'ingredient';
/** Em que a pessoa está digitando: embalagens fechadas ou unidades soltas (latas, ml, g). */
export type QtyMode = 'pack' | 'unit';
/** Como o custo foi informado: por embalagem, por unidade solta ou o total pago. */
export type CostMode = 'pack' | 'unit' | 'total';

export interface Packaging {
  measure: Measure;
  /** Conteúdo de uma embalagem em milli (fardo de 12 = 12_000; garrafa de 1 L = 1_000_000). */
  packageQty: QtyMilli;
  /** Nome da embalagem: "fardo", "caixa", "garrafa", "pacote". */
  packageLabel?: string | null;
  /** Nome da unidade avulsa (só para produtos por unidade): "lata", "long neck", "maço". */
  unitLabel?: string | null;
}

export const BUY_MODE_MEASURE: Record<BuyMode, Measure> = { single: 'unit', pack: 'unit', bottle: 'volume', bag: 'mass' };

export const DEFAULT_PACKAGE_LABEL: Record<BuyMode, string> = { single: 'unidade', pack: 'fardo', bottle: 'garrafa', bag: 'pacote' };

export function buyModeOf(p: Pick<Packaging, 'measure' | 'packageQty'>): BuyMode {
  if (p.measure === 'volume') return 'bottle';
  if (p.measure === 'mass') return 'bag';
  return p.packageQty > MILLI ? 'pack' : 'single';
}

// ------------------------------------------------------------------ texto

const IRREGULAR_PLURAL: Record<string, string> = { pão: 'pães', mão: 'mãos' };

function pluralWord(word: string): string {
  const lower = word.toLocaleLowerCase('pt-BR');
  const irregular = IRREGULAR_PLURAL[lower];
  if (irregular) return word === lower ? irregular : word[0] + irregular.slice(1);
  if (/ão$/i.test(word)) return word.slice(0, -2) + 'ões';
  if (/[aeiouáéíóúâêôã]$/i.test(word)) return word + 's';
  if (/m$/i.test(word)) return word.slice(0, -1) + 'ns';
  if (/il$/i.test(word)) return word.slice(0, -2) + 'is';
  if (/el$/i.test(word)) return word.slice(0, -2) + 'éis';
  if (/ol$/i.test(word)) return word.slice(0, -2) + 'óis';
  if (/[au]l$/i.test(word)) return word.slice(0, -1) + 'is';
  if (/[rz]$/i.test(word)) return word + 'es';
  if (/[sx]$/i.test(word)) return word;
  return word + 's';
}

/**
 * Plural simples do português para rótulos curtos ("lata" → "latas",
 * "barril" → "barris"). Em expressões, flexiona a primeira palavra
 * ("garrafa long neck" → "garrafas long neck"), exceto em termos importados
 * ("long neck" → "long necks").
 */
export function pluralPt(label: string): string {
  const words = label.trim().split(/\s+/);
  if (!words[0]) return label;
  const imported = words.length > 1 && /[bcdfghjkpqtvwxyn]$/i.test(words[0]);
  if (imported) return [...words.slice(0, -1), words[words.length - 1] + 's'].join(' ');
  return [pluralWord(words[0]), ...words.slice(1)].join(' ');
}

const FEMININE_WORDS = new Set(['dose', 'long', 'unidade', 'bag']);
const MASCULINE_WORDS = new Set(['dia', 'mapa', 'sistema', 'programa']);

/** Gênero aproximado de um rótulo, para concordar "fechados"/"fechadas", "soltos"/"soltas". */
export function isFemininePt(label: string): boolean {
  const word = (label.trim().split(/\s+/)[0] ?? '').toLocaleLowerCase('pt-BR');
  if (FEMININE_WORDS.has(word)) return true;
  if (MASCULINE_WORDS.has(word)) return false;
  return /([aã]|dade|ção|são|gem|ice)$/.test(word);
}

/** Concordância de número: singular de 0 < |n| < 2 ("1,5 garrafa"), plural no resto ("0 latas"). */
export function labelFor(label: string, n: number): string {
  const abs = Math.abs(n);
  return abs > 0 && abs < 2 ? label : pluralPt(label);
}

const nf = (max: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: max, minimumFractionDigits: 0 });
const NF0 = nf(0);
const NF1 = nf(1);
const NF2 = nf(2);

/** Número no padrão brasileiro com até 2 casas: 2,5 · 1.000 · 12. */
export function fmtCount(n: number, maxDecimals = 2): string {
  return (maxDecimals === 2 ? NF2 : maxDecimals === 0 ? NF0 : nf(maxDecimals)).format(n);
}

function baseLabel(measure: Measure): string {
  return measure === 'volume' ? 'ml' : measure === 'mass' ? 'g' : 'un';
}

/** Nome da unidade solta: "lata"/"latas", "ml", "g". */
export function unitName(p: Packaging, n = 1): string {
  if (p.measure !== 'unit') return baseLabel(p.measure);
  const label = p.unitLabel?.trim() || (buyModeOf(p) === 'single' ? p.packageLabel?.trim() : '') || 'unidade';
  return labelFor(label, n);
}

/** Nome da embalagem: "fardo"/"fardos", "garrafa"/"garrafas". */
export function packName(p: Packaging, n = 1): string {
  const mode = buyModeOf(p);
  if (mode === 'single') return unitName(p, n);
  return labelFor(p.packageLabel?.trim() || DEFAULT_PACKAGE_LABEL[mode], n);
}

/** Quantas unidades soltas (latas, ml ou g) cabem em uma embalagem. */
export function unitsPerPack(p: Packaging): number {
  return p.packageQty / MILLI;
}

/** "lata", "fardo de 12 latas", "garrafa de 1.000 ml", "pacote de 50 g". */
export function describePack(p: Packaging): string {
  if (buyModeOf(p) === 'single') return unitName(p, 1);
  const n = unitsPerPack(p);
  return `${packName(p, 1)} de ${fmtCount(n)} ${unitName(p, n)}`;
}

/** Quantidade solta com o nome certo: "24 latas", "2.500 ml", "1 lata". */
export function unitsText(qty: QtyMilli, p: Packaging): string {
  const n = qty / MILLI;
  return `${p.measure === 'unit' ? fmtCount(n) : NF1.format(n)} ${unitName(p, n)}`;
}

/** Quantidade em embalagens: "2 fardos", "2,5 garrafas". */
export function packsText(qty: QtyMilli, p: Packaging): string {
  const n = qty / p.packageQty;
  return `${fmtCount(n)} ${packName(p, n)}`;
}

/**
 * Embalagens fechadas + sobra solta: "4 fardos", "3 fardos + 6 latas".
 * Retorna null quando não há nem uma embalagem inteira.
 */
export function packBreakdownText(qty: QtyMilli, p: Packaging): string | null {
  if (qty <= 0 || p.packageQty <= 0) return null;
  const closed = Math.floor(qty / p.packageQty);
  if (closed < 1) return null;
  const rest = qty - closed * p.packageQty;
  const head = `${fmtCount(closed, 0)} ${packName(p, closed)}`;
  return rest > 0 ? `${head} + ${unitsText(rest, p)}` : head;
}

export interface QtyText {
  /** Forma principal: "48 latas", "2,5 garrafas". */
  main: string;
  /** Forma alternativa entre parênteses: "4 fardos", "2.500 ml" (null quando redundante). */
  detail: string | null;
}

/**
 * Saldo nas duas formas, para listas de estoque:
 *   unidade em fardos → "48 latas" (4 fardos)
 *   garrafa/pacote    → "2,5 garrafas" (2.500 ml)
 */
export function describeStock(qty: QtyMilli, p: Packaging): QtyText {
  const mode = buyModeOf(p);
  if (mode === 'single') return { main: unitsText(qty, p), detail: null };
  if (mode === 'pack') return { main: unitsText(qty, p), detail: qty > 0 ? packBreakdownText(qty, p) : null };
  return { main: packsText(qty, p), detail: qty === 0 ? null : unitsText(qty, p) };
}

/** Texto único: "48 latas (4 fardos)" / "2,5 garrafas (2.500 ml)". */
export function stockText(qty: QtyMilli, p: Packaging): string {
  const t = describeStock(qty, p);
  return t.detail ? `${t.main} (${t.detail})` : t.main;
}

// ------------------------------------------------------------- conversões

/** Fator (milli) de 1 unidade digitada no modo escolhido. */
export function modeFactor(mode: QtyMode, p: Packaging): number {
  return mode === 'pack' ? p.packageQty : MILLI;
}

/** Número digitado (em embalagens ou unidades soltas) → milli. */
export function qtyFrom(amount: number, mode: QtyMode, p: Packaging): QtyMilli {
  return Math.round(amount * modeFactor(mode, p));
}

/** Milli → número no modo escolhido (pode ser decimal). */
export function amountIn(qty: QtyMilli, mode: QtyMode, p: Packaging): number {
  return qty / modeFactor(mode, p);
}

/** Modo mais natural para exibir/editar uma quantidade já gravada (ex.: estoque mínimo). */
export function preferredMode(qty: QtyMilli, p: Packaging): QtyMode {
  if (buyModeOf(p) === 'single') return 'unit';
  return qty === 0 || qty % p.packageQty === 0 ? 'pack' : 'unit';
}

/** Quantidade (milli) de uma entrada informada em embalagens ou direto em unidades soltas. */
export function entryQtyMilli(entry: { packages?: number | null; qty?: number | null }, packageQty: QtyMilli): QtyMilli {
  if (entry.qty !== undefined && entry.qty !== null) return entry.qty;
  return Math.round((entry.packages ?? 0) * packageQty);
}

/** Contagem física: embalagens fechadas + unidades soltas (latas, ml da aberta, g do pacote aberto). */
export function countQty(closed: number | null, loose: number | null, p: Packaging): QtyMilli {
  const packs = buyModeOf(p) === 'single' ? 0 : closed ?? 0;
  return Math.round(packs * p.packageQty + (loose ?? 0) * MILLI);
}

/** Total pago a partir do custo digitado por embalagem, por unidade solta ou total. */
export function totalCostFrom(cents: Cents, mode: CostMode, qty: QtyMilli, p: Packaging): Cents {
  if (mode === 'total') return cents;
  return Math.round((cents * qty) / modeFactor(mode, p));
}

/** Custo de uma quantidade de referência (ex.: 1 lata, 1 dose) dentro de uma entrada. */
export function costPer(totalCents: Cents, qty: QtyMilli, refQty: QtyMilli): Cents | null {
  if (qty <= 0 || refQty <= 0) return null;
  return Math.round((totalCents * refQty) / qty);
}

// ------------------------------------------------------ frase de conferência

export interface EntryText {
  /** O que foi digitado, em palavras: "2 fardos de 12", "30 latas", "1 garrafa de 1.000 ml". */
  lead: string;
  /** Equivalências: ["24 latas"], ["2 fardos + 6 latas"], ["20 doses de 50 ml"]. */
  equals: string[];
}

/**
 * Frase de conferência ao lançar estoque:
 *   "2 fardos de 12" = "24 latas"
 *   "1 garrafa de 1.000 ml" = "20 doses de 50 ml"
 */
export function describeEntry(amount: number, mode: QtyMode, p: Packaging, doseQty?: QtyMilli | null): EntryText {
  const buy = buyModeOf(p);
  const qty = qtyFrom(amount, mode, p);
  const equals: string[] = [];
  let lead: string;
  if (buy === 'single') {
    lead = unitsText(qty, p);
  } else if (mode === 'pack') {
    const n = unitsPerPack(p);
    lead = buy === 'pack'
      ? `${fmtCount(amount)} ${packName(p, amount)} de ${fmtCount(n)}`
      : `${fmtCount(amount)} ${packName(p, amount)} de ${fmtCount(n)} ${unitName(p, n)}`;
    if (buy === 'pack' || amount !== 1 || !doseQty) equals.push(unitsText(qty, p));
  } else {
    lead = unitsText(qty, p);
    const packs = buy === 'pack' ? packBreakdownText(qty, p) : qty >= p.packageQty / 10 ? `${packsText(qty, p)} de ${fmtCount(unitsPerPack(p))} ${unitName(p, unitsPerPack(p))}` : null;
    if (packs) equals.push(packs);
  }
  if (doseQty && doseQty > 0 && p.measure !== 'unit') {
    const doses = Math.floor(qty / doseQty);
    const word = p.measure === 'volume' ? 'dose' : 'porção';
    equals.push(`${fmtCount(doses, 0)} ${labelFor(word, doses)} de ${unitsText(doseQty, p)}`);
  }
  return { lead, equals };
}

export interface EntrySuggestion {
  /** Modo que provavelmente era o pretendido (o número digitado continua o mesmo). */
  mode: QtyMode;
  qty: QtyMilli;
  /** Pergunta pronta: "Você quis dizer 2 fardos (24 latas)?" */
  message: string;
}

/**
 * Detecta enganos comuns entre embalagem e unidade solta:
 *   - digitou 2 em "latas" num fardo de 12 → "Você quis dizer 2 fardos (24 latas)?"
 *   - digitou 24 em "fardos" de 12         → "Você quis dizer 24 latas (2 fardos)?"
 *   - digitou 2 em "ml" numa garrafa de 1 L → "Você quis dizer 2 garrafas (2.000 ml)?"
 *   - digitou 700 em "garrafas"            → "Você quis dizer 700 ml (1 garrafa)?"
 */
export function entrySuggestion(amount: number | null | undefined, mode: QtyMode, p: Packaging): EntrySuggestion | null {
  const buy = buyModeOf(p);
  if (buy === 'single' || !amount || amount <= 0 || !Number.isInteger(amount)) return null;
  const perPack = unitsPerPack(p);
  if (mode === 'unit') {
    const looksLikePacks = buy === 'pack' ? amount < perPack : amount <= 20 && amount * MILLI <= p.packageQty / 10;
    if (!looksLikePacks) return null;
    const qty = qtyFrom(amount, 'pack', p);
    return { mode: 'pack', qty, message: `Você quis dizer ${fmtCount(amount)} ${packName(p, amount)} (${unitsText(qty, p)})?` };
  }
  const looksLikeUnits = buy === 'pack' ? perPack > 1 && amount >= perPack && amount % perPack === 0 : amount >= 100;
  if (!looksLikeUnits) return null;
  const qty = qtyFrom(amount, 'unit', p);
  const packs = buy === 'pack' ? packBreakdownText(qty, p) : packsText(qty, p);
  return { mode: 'unit', qty, message: `Você quis dizer ${unitsText(qty, p)}${packs ? ` (${packs})` : ''}?` };
}

// ------------------------------------------------------------ código interno

export const PRODUCT_CODE_DIGITS = 4;

/** 7 → "0007"; acima de 9999 cresce naturalmente ("10000"). */
export function formatProductCode(n: number): string {
  return String(n).padStart(PRODUCT_CODE_DIGITS, '0');
}

/** Chave de comparação: "0007", "7" e "#7" representam o mesmo código. */
export function productCodeKey(code: string): string {
  const t = code.trim().replace(/^#/, '');
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t.toLocaleLowerCase('pt-BR');
}

/**
 * Próximo código sequencial livre depois de `last` (último número já emitido),
 * pulando códigos usados — inclusive os equivalentes sem zeros ("7" bloqueia "0007").
 */
export function nextProductCode(taken: Iterable<string | null | undefined>, last = 0): { code: string; seq: number } {
  const keys = new Set<string>();
  for (const c of taken) if (c) keys.add(productCodeKey(c));
  let n = Math.max(0, Math.floor(last)) + 1;
  while (keys.has(String(n))) n++;
  return { code: formatProductCode(n), seq: n };
}

/** Busca por código: "7", "07" e "#0007" encontram "0007"; texto encontra por prefixo. */
export function matchesProductCode(code: string | null | undefined, query: string): boolean {
  const q = query.trim().replace(/^#/, '');
  if (!code || !q) return false;
  if (/^\d+$/.test(q) && productCodeKey(code) === productCodeKey(q)) return true;
  return code.toLocaleLowerCase('pt-BR').startsWith(q.toLocaleLowerCase('pt-BR'));
}
