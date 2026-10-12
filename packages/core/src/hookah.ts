import type { Cents } from './money';

/**
 * Cobrança de locação de narguilé.
 *  - fixed: valor fixo por sessão.
 *  - per_period: valor por período iniciado (ex.: R$ 30 a cada 60 min),
 *    com tolerância configurável antes de cobrar um novo período.
 */
export type HookahPricingMode = 'fixed' | 'per_period';

export interface HookahPricing {
  mode: HookahPricingMode;
  /** Valor fixo (mode=fixed) ou valor por período (mode=per_period). */
  priceCents: Cents;
  /** Duração do período em minutos (mode=per_period). */
  periodMinutes?: number;
  /** Minutos de tolerância antes de iniciar a cobrança de um novo período. */
  toleranceMinutes?: number;
}

export interface HookahCharge {
  minutes: number;
  periods: number;
  totalCents: Cents;
  description: string;
}

export function hookahCharge(pricing: HookahPricing, startedAt: Date | number, endedAt: Date | number): HookahCharge {
  const start = typeof startedAt === 'number' ? startedAt : startedAt.getTime();
  const end = typeof endedAt === 'number' ? endedAt : endedAt.getTime();
  const minutes = Math.max(0, Math.ceil((end - start) / 60_000));
  if (pricing.mode === 'fixed') {
    return { minutes, periods: 1, totalCents: pricing.priceCents, description: 'Valor fixo' };
  }
  const period = Math.max(1, pricing.periodMinutes ?? 60);
  const tolerance = Math.max(0, pricing.toleranceMinutes ?? 0);
  let periods = 1;
  if (minutes > period) {
    periods = 1 + Math.ceil(Math.max(0, minutes - period - tolerance) / period);
  }
  return {
    minutes,
    periods,
    totalCents: periods * pricing.priceCents,
    description: `${periods} × ${period} min`,
  };
}

/**
 * Consumo padrão por rosh, em gramas. 12 g é apenas um valor ilustrativo inicial;
 * o estabelecimento configura o seu próprio padrão e cada sessão pode ajustá-lo.
 */
export const ILLUSTRATIVE_GRAMS_PER_ROSH = 12;

export interface EssenceShare {
  productId: string;
  /** Peso em milli-gramas. */
  qty: number;
}

/**
 * Divide o total de um rosh entre sabores de uma mistura conforme proporções.
 * Proporções inteiras (ex.: 2:1). O resto do arredondamento vai para o primeiro sabor.
 */
export function splitMix(totalMilli: number, mix: { productId: string; ratio: number }[]): EssenceShare[] {
  const valid = mix.filter((m) => m.ratio > 0);
  if (valid.length === 0) return [];
  const ratioSum = valid.reduce((a, m) => a + m.ratio, 0);
  const shares = valid.map((m) => ({ productId: m.productId, qty: Math.floor((totalMilli * m.ratio) / ratioSum) }));
  const assigned = shares.reduce((a, s) => a + s.qty, 0);
  shares[0]!.qty += totalMilli - assigned;
  return shares;
}
