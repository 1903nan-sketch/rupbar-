'use client';
import { billTotals, formatBRL } from '@rupbar/core';
import { useState } from 'react';

/** Valor (R$ ou %) e motivo do desconto, mostrando quanto a comanda vai ficar. */
export function DiscountFields({ subtotalCents, serviceFeeBp, currentCents }: { subtotalCents: number; serviceFeeBp: number; currentCents: number }) {
  const [raw, setRaw] = useState('');
  const value = (() => {
    const s = raw.replace(/r\$/i, '').replace(/\s/g, '');
    if (!s) return null;
    if (s.endsWith('%')) {
      const pct = Number(s.slice(0, -1).replace(',', '.'));
      return Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round((subtotalCents * pct) / 100) : null;
    }
    const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  })();
  const now = billTotals([{ quantity: 1, unitPrice: subtotalCents }], { discount: currentCents, serviceFeeBp }).total;
  const after = value === null ? null : billTotals([{ quantity: 1, unitPrice: subtotalCents }], { discount: value, serviceFeeBp }).total;
  return (
    <>
      <input type="hidden" name="subtotalCents" value={subtotalCents} />
      <div className="grid-2 tight">
        <div className="field">
          <label htmlFor="discountValue">Desconto (R$ ou %)</label>
          <input id="discountValue" name="value" className="input" inputMode="decimal" placeholder="Ex.: 15,00 ou 10%" value={raw} onChange={(e) => setRaw(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="discountReason">Motivo</label>
          <input id="discountReason" name="reason" className="input" maxLength={200} placeholder="Ex.: cliente fiel" />
        </div>
      </div>
      <p className="small muted discount-preview" aria-live="polite">
        {after === null ? (
          <>Hoje: {formatBRL(now)}. Para tirar o desconto, digite 0.</>
        ) : value! > subtotalCents ? (
          <span className="danger-text">O desconto é maior que o valor dos itens ({formatBRL(subtotalCents)}).</span>
        ) : (
          <>
            {formatBRL(now)} → <strong>{formatBRL(after)}</strong>
            {value ? ` (− ${formatBRL(value)})` : ' (sem desconto)'}
          </>
        )}
      </p>
    </>
  );
}
