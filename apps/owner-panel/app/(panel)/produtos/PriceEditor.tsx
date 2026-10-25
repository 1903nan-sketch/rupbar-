'use client';
import { formatBRL } from '@rupbar/core';
import { CircleAlert, CircleCheck, Tag } from 'lucide-react';
import { startTransition, useActionState, useEffect, useState } from 'react';
import { updatePrices, type ActionState } from '../acoes';

export interface PriceRow { id: string; name: string; priceCents: number }

const toRaw = (c: number) => (c / 100).toFixed(2).replace('.', ',');
function toCents(raw: string): number | null {
  const s = raw.replace(/r\$/i, '').replace(/\s/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** Preço de cada apresentação (Unidade, Dose 50 ml, Balde…); envia só o que mudou. */
export function PriceEditor({ productId, productName, rows }: { productId: string; productName: string; rows: PriceRow[] }) {
  const [state, run, busy] = useActionState<ActionState | null, FormData>(updatePrices, null);
  const [raw, setRaw] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.id, toRaw(r.priceCents)])));
  // Preços novos chegam do PC (ou de outro envio): a tela acompanha.
  const key = rows.map((r) => `${r.id}:${r.priceCents}`).join(',');
  useEffect(() => setRaw(Object.fromEntries(rows.map((r) => [r.id, toRaw(r.priceCents)]))), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = rows.map((r) => ({ ...r, next: toCents(raw[r.id] ?? '') }));
  const invalid = parsed.some((r) => r.next === null);
  const changed = parsed.filter((r) => r.next !== null && r.next !== r.priceCents);

  return (
    <form
      className="stack price-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid || !changed.length) return;
        const data = new FormData(e.currentTarget);
        startTransition(() => run(data));
      }}
    >
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="productName" value={productName} />
      <input type="hidden" name="prices" value={JSON.stringify(changed.map((r) => ({ presentationId: r.id, priceCents: r.next, name: r.name })))} />
      {parsed.map((r) => (
        <div key={r.id} className={`price-line ${r.next !== null && r.next !== r.priceCents ? 'changed' : ''}`}>
          <label htmlFor={`price-${r.id}`} className="grow">
            <span className="strong">{r.name}</span>
            {r.next !== null && r.next !== r.priceCents && <span className="tiny muted"> · era {formatBRL(r.priceCents)}</span>}
          </label>
          <div className="input-money">
            <span aria-hidden="true">R$</span>
            <input id={`price-${r.id}`} className="input" inputMode="decimal" value={raw[r.id] ?? ''} onChange={(e) => setRaw({ ...raw, [r.id]: e.target.value })} />
          </div>
        </div>
      ))}
      {invalid && <p className="small danger-text">Confira os preços.</p>}
      <button className="btn primary" type="submit" disabled={busy || invalid || !changed.length}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Tag size={17} aria-hidden="true" />}
        {busy ? 'Enviando…' : changed.length ? `Salvar ${changed.length === 1 ? '1 preço' : `${changed.length} preços`}` : 'Altere um preço'}
      </button>
      {state && (
        <div className={`banner ${state.ok ? 'success' : 'danger'}`} role={state.ok ? 'status' : 'alert'}>
          <span className="banner-icon" aria-hidden="true">{state.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}</span>
          <span>{state.message}</span>
        </div>
      )}
    </form>
  );
}
