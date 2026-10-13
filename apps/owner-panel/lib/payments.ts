import { PAYMENT_METHODS, type PaymentMethod } from '@rupbar/core';
import type { DonutSegment } from '@/components/charts/Donut';

/**
 * Cor fixa por forma de pagamento (a cor segue a forma, nunca a posição no
 * ranking). A ordem do anel também é fixa, para vizinhos sempre distintos.
 */
const ORDER: PaymentMethod[] = ['pix', 'credit', 'debit', 'cash', 'voucher', 'other'];
const COLOR: Record<PaymentMethod, string> = {
  pix: 'var(--series-1)',
  credit: 'var(--series-2)',
  debit: 'var(--series-3)',
  cash: 'var(--series-4)',
  voucher: 'var(--series-5)',
  other: 'var(--series-6)',
};

export function paymentSegments(rows: { method: PaymentMethod | string; total: number; count?: number }[]): DonutSegment[] {
  const byKey = new Map(rows.map((r) => [r.method, r]));
  const keys = [...ORDER.filter((k) => byKey.has(k)), ...rows.map((r) => r.method).filter((k) => !ORDER.includes(k as PaymentMethod))];
  return keys.map((k) => {
    const r = byKey.get(k)!;
    const count = Number(r.count ?? 0);
    return {
      key: k,
      label: PAYMENT_METHODS[k as PaymentMethod] ?? k,
      value: Number(r.total),
      color: COLOR[k as PaymentMethod] ?? 'var(--series-6)',
      meta: count ? `${count} pagamento${count > 1 ? 's' : ''}` : undefined,
    };
  });
}
