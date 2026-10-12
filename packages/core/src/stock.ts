import type { Cents } from './money';
import { roundHalfEven } from './money';
import type { Measure, QtyMilli } from './units';
import { MILLI } from './units';

/**
 * Custo unitário é guardado como "centavos por unidade-base × 10⁴" (unit_cost_e4).
 * Ex.: whisky de 1 L a R$ 120,00 → 12 centavos/ml → 120_000.
 * Ex.: essência 100 g a R$ 45,00 → 45 centavos/g → 450_000.
 */
export type UnitCostE4 = number;
const E4 = 10_000;

/** Custo unitário a partir de uma compra: total pago pela quantidade recebida. */
export function unitCostFromPurchase(totalCents: Cents, qty: QtyMilli): UnitCostE4 {
  if (qty <= 0) return 0;
  // centavos por unidade-base = total / (qty / 1000)
  return Math.round((totalCents * MILLI * E4) / qty);
}

/** Custo (em centavos) de uma quantidade, dado o custo unitário. */
export function costOf(qty: QtyMilli, unitCostE4: UnitCostE4): Cents {
  return roundHalfEven((qty * unitCostE4) / (MILLI * E4));
}

/**
 * Custo médio ponderado após uma entrada de mercadoria.
 * Saldos negativos (vendas sem estoque lançado) não entram na média.
 */
export function weightedAverageCost(
  currentQty: QtyMilli,
  currentCost: UnitCostE4,
  incomingQty: QtyMilli,
  incomingCost: UnitCostE4,
): UnitCostE4 {
  const cq = Math.max(0, currentQty);
  const total = cq + incomingQty;
  if (total <= 0) return incomingCost;
  return Math.round((cq * currentCost + incomingQty * incomingCost) / total);
}

/** Rendimento teórico: quantas doses de `doseQty` cabem em uma embalagem. */
export function theoreticalYield(packageQty: QtyMilli, doseQty: QtyMilli): number {
  if (doseQty <= 0) return 0;
  return Math.floor(packageQty / doseQty);
}

export interface PackageBreakdown {
  /** Embalagens fechadas (inteiras). */
  closed: number;
  /** Conteúdo restante na embalagem aberta (0 se nenhuma aberta). */
  openRemaining: QtyMilli;
  /** Há uma embalagem aberta? */
  hasOpen: boolean;
}

/**
 * Decompõe o saldo em embalagens fechadas + uma aberta.
 * Ex.: 2.350 ml de whisky em garrafas de 1 L → 2 fechadas e 350 ml na aberta.
 * Pressupõe a prática usual de abrir uma embalagem por vez.
 */
export function packageBreakdown(stock: QtyMilli, packageQty: QtyMilli): PackageBreakdown {
  if (packageQty <= 0 || stock <= 0) return { closed: 0, openRemaining: Math.max(0, stock), hasOpen: stock > 0 && packageQty <= 0 };
  const closed = Math.floor(stock / packageQty);
  const openRemaining = stock - closed * packageQty;
  return { closed, openRemaining, hasOpen: openRemaining > 0 };
}

/** Quantidade contada em inventário a partir de embalagens fechadas + restante estimado. */
export function countedFromPackages(closed: number, openRemaining: QtyMilli, packageQty: QtyMilli): QtyMilli {
  return closed * packageQty + openRemaining;
}

export interface Divergence {
  expected: QtyMilli;
  counted: QtyMilli;
  diff: QtyMilli;
  /** Diferença relativa em pontos-base (sinalizada). */
  diffBp: number;
}

export function divergence(expected: QtyMilli, counted: QtyMilli): Divergence {
  const diff = counted - expected;
  const diffBp = expected === 0 ? (diff === 0 ? 0 : diff > 0 ? 10_000 : -10_000) : Math.round((diff * 10_000) / Math.abs(expected));
  return { expected, counted, diff, diffBp };
}

export type StockLevel = 'ok' | 'low' | 'out' | 'negative';

export function stockLevel(stock: QtyMilli, min: QtyMilli): StockLevel {
  if (stock < 0) return 'negative';
  if (stock === 0) return 'out';
  if (min > 0 && stock <= min) return 'low';
  return 'ok';
}

/**
 * Sugestão de reposição: completar até 2× o mínimo, arredondando para embalagens inteiras.
 * Retorna a quantidade e o número de embalagens.
 */
export function restockSuggestion(
  stock: QtyMilli,
  min: QtyMilli,
  packageQty: QtyMilli,
  targetMultiplier = 2,
): { qty: QtyMilli; packages: number } {
  const target = min * targetMultiplier;
  const missing = Math.max(0, target - Math.max(0, stock));
  if (missing === 0) return { qty: 0, packages: 0 };
  const pkg = packageQty > 0 ? packageQty : MILLI;
  const packages = Math.ceil(missing / pkg);
  return { qty: packages * pkg, packages };
}

export interface Component {
  productId: string;
  qty: QtyMilli;
}

/**
 * Consumo total de ingredientes para `quantity` unidades de uma apresentação.
 * Agrega ingredientes repetidos (ex.: dois componentes do mesmo produto).
 */
export function consumptionFor(components: readonly Component[], quantity: number): Map<string, QtyMilli> {
  const out = new Map<string, QtyMilli>();
  for (const c of components) {
    out.set(c.productId, (out.get(c.productId) ?? 0) + c.qty * quantity);
  }
  return out;
}

export function measureOfBaseLabel(measure: Measure): string {
  return measure === 'volume' ? 'ml' : measure === 'mass' ? 'g' : 'un';
}
