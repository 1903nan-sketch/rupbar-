import type { PaymentMethod } from './domain';
import type { Cents } from './money';

export interface CashClosingInput {
  openingBalance: Cents;
  payments: { method: PaymentMethod; amount: Cents }[];
  withdrawals: Cents[];
  supplies: Cents[];
  /** Dinheiro efetivamente contado na gaveta (null enquanto não informado). */
  countedCash: Cents | null;
}

export interface CashClosingSummary {
  byMethod: Record<string, Cents>;
  totalSales: Cents;
  withdrawals: Cents;
  supplies: Cents;
  expectedCash: Cents;
  countedCash: Cents | null;
  /** counted − expected. Negativo = falta; positivo = sobra. */
  difference: Cents | null;
}

/**
 * Valor esperado em dinheiro = saldo inicial + recebimentos em dinheiro
 *                            + suprimentos − sangrias.
 * O troco já está descontado: `amount` é o valor aplicado à conta.
 */
export function cashClosing(input: CashClosingInput): CashClosingSummary {
  const byMethod: Record<string, Cents> = {};
  let totalSales = 0;
  for (const p of input.payments) {
    byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    totalSales += p.amount;
  }
  const withdrawals = input.withdrawals.reduce((a, b) => a + b, 0);
  const supplies = input.supplies.reduce((a, b) => a + b, 0);
  const expectedCash = input.openingBalance + (byMethod.cash ?? 0) + supplies - withdrawals;
  return {
    byMethod,
    totalSales,
    withdrawals,
    supplies,
    expectedCash,
    countedCash: input.countedCash,
    difference: input.countedCash === null ? null : input.countedCash - expectedCash,
  };
}

/** Troco para pagamento em dinheiro. */
export function changeFor(amountDue: Cents, received: Cents): Cents {
  return Math.max(0, received - amountDue);
}

export interface BillTotals {
  subtotal: Cents;
  discount: Cents;
  serviceFee: Cents;
  total: Cents;
  paid: Cents;
  remaining: Cents;
}

export function billTotals(
  items: { quantity: number; unitPrice: Cents; canceled?: boolean }[],
  opts: { discount?: Cents; serviceFeeBp?: number; paid?: Cents } = {},
): BillTotals {
  const subtotal = items.filter((i) => !i.canceled).reduce((a, i) => a + i.quantity * i.unitPrice, 0);
  const discount = Math.min(Math.max(0, opts.discount ?? 0), subtotal);
  const base = subtotal - discount;
  const serviceFee = Math.round((base * (opts.serviceFeeBp ?? 0)) / 10_000);
  const total = base + serviceFee;
  const paid = opts.paid ?? 0;
  return { subtotal, discount, serviceFee, total, paid, remaining: total - paid };
}
