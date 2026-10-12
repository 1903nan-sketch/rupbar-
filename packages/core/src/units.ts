/**
 * Quantidades de estoque usam unidades-base inteiras em milésimos ("milli"):
 *
 *   - volume  → mililitro (ml)   1 ml   = 1000 milli
 *   - massa   → grama (g)        1 g    = 1000 milli
 *   - unidade → unidade (un)     1 un   = 1000 milli
 *
 * Assim 30 ml = 30_000, 0,5 g = 500 e meia unidade = 500, sem ponto flutuante.
 * Uma garrafa de 1 L de whisky = 1_000_000 milli-ml; vender 50 ml desconta 50_000.
 */

export type Measure = 'unit' | 'volume' | 'mass';
export type QtyMilli = number;

export const MILLI = 1000;

export interface UnitDef {
  code: string;
  label: string;
  measure: Measure;
  /** Quantas unidades-base (ml, g ou un) cabem em 1 desta unidade. */
  factor: number;
}

export const UNITS: Record<string, UnitDef> = {
  un: { code: 'un', label: 'unidade', measure: 'unit', factor: 1 },
  cx: { code: 'cx', label: 'caixa', measure: 'unit', factor: 1 }, // fator real vem do cadastro
  ml: { code: 'ml', label: 'mililitro', measure: 'volume', factor: 1 },
  l: { code: 'l', label: 'litro', measure: 'volume', factor: 1000 },
  g: { code: 'g', label: 'grama', measure: 'mass', factor: 1 },
  kg: { code: 'kg', label: 'quilograma', measure: 'mass', factor: 1000 },
};

export const BASE_UNIT: Record<Measure, 'un' | 'ml' | 'g'> = {
  unit: 'un',
  volume: 'ml',
  mass: 'g',
};

export const MEASURE_LABEL: Record<Measure, string> = {
  unit: 'Unidade',
  volume: 'Volume (ml)',
  mass: 'Peso (g)',
};

export function unitsFor(measure: Measure): UnitDef[] {
  return Object.values(UNITS).filter((u) => u.measure === measure && u.code !== 'cx');
}

/** Converte uma quantidade decimal informada em uma unidade para milli da unidade-base. */
export function toMilli(amount: number, unitCode: string): QtyMilli {
  const unit = UNITS[unitCode];
  if (!unit) throw new RangeError(`Unidade desconhecida: ${unitCode}`);
  if (!Number.isFinite(amount)) throw new RangeError('Quantidade inválida');
  return Math.round(amount * unit.factor * MILLI);
}

/** Converte milli da unidade-base para a unidade pedida (pode retornar decimal). */
export function fromMilli(qty: QtyMilli, unitCode: string): number {
  const unit = UNITS[unitCode];
  if (!unit) throw new RangeError(`Unidade desconhecida: ${unitCode}`);
  return qty / MILLI / unit.factor;
}

export function assertMilli(value: number, field = 'quantidade'): QtyMilli {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} deve ser inteiro (milésimos)`);
  return value;
}

const nf = (max: number) =>
  new Intl.NumberFormat('pt-BR', { maximumFractionDigits: max, minimumFractionDigits: 0 });

/**
 * Formata uma quantidade para leitura humana escolhendo a melhor unidade.
 * formatQty(1_500_000, 'volume') => "1,5 L"; formatQty(30_000, 'volume') => "30 ml".
 */
export function formatQty(qty: QtyMilli, measure: Measure): string {
  const base = qty / MILLI;
  const abs = Math.abs(base);
  switch (measure) {
    case 'volume':
      return abs >= 1000 ? `${nf(3).format(base / 1000)} L` : `${nf(1).format(base)} ml`;
    case 'mass':
      return abs >= 1000 ? `${nf(3).format(base / 1000)} kg` : `${nf(1).format(base)} g`;
    case 'unit':
    default:
      return `${nf(3).format(base)} un`;
  }
}

/** Interpreta texto como "1,5", "30" em uma unidade e devolve milli. */
export function parseQty(input: string, unitCode: string): QtyMilli | null {
  const s = input.trim().replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return toMilli(Number(s), unitCode);
}
