'use client';
import { LOSS_REASONS, type LossReason } from '@rupbar/core';
import { CircleAlert, CircleCheck, Info, Send } from 'lucide-react';
import { useActionState, useState } from 'react';
import { registerLoss, type ActionState } from './actions';

const UNITS: Record<string, { code: string; label: string }[]> = {
  unit: [{ code: 'un', label: 'unidades' }],
  volume: [{ code: 'ml', label: 'ml' }, { code: 'l', label: 'litros' }],
  mass: [{ code: 'g', label: 'gramas' }, { code: 'kg', label: 'kg' }],
};

export function LossForm({ products }: { products: { id: string; name: string; measure: string }[] }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(registerLoss, null);
  const [productId, setProductId] = useState('');
  const measure = products.find((p) => p.id === productId)?.measure ?? 'unit';
  return (
    <form action={action} className="stack loss-form">
      <div className="field">
        <label htmlFor="productId">Produto</label>
        <select id="productId" name="productId" className="select" required value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">Selecione…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid-2 tight">
        <div className="field">
          <label htmlFor="amount">Quantidade</label>
          <input id="amount" name="amount" className="input" inputMode="decimal" placeholder="Ex.: 2 ou 0,5" required />
        </div>
        <div className="field">
          <label htmlFor="unit">Unidade</label>
          <select id="unit" name="unit" className="select" key={measure}>
            {UNITS[measure]!.map((u) => (
              <option key={u.code} value={u.code}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid-2 tight">
        <div className="field">
          <label htmlFor="reason">Motivo</label>
          <select id="reason" name="reason" className="select" required defaultValue="broken">
            {(Object.keys(LOSS_REASONS) as LossReason[]).map((r) => (
              <option key={r} value={r}>
                {LOSS_REASONS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="occurredAt">Data e horário</label>
          <input id="occurredAt" name="occurredAt" type="datetime-local" className="input" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="notes">Observações</label>
        <textarea id="notes" name="notes" className="textarea" maxLength={400} placeholder="Opcional — ex.: garrafa caiu durante a reposição" />
      </div>
      {state && (
        <div className={`banner ${state.ok ? 'success' : 'danger'}`} role={state.ok ? 'status' : 'alert'}>
          <span className="banner-icon" aria-hidden="true">
            {state.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
          </span>
          <span>{state.message}</span>
        </div>
      )}
      <button className="btn primary large block" type="submit" disabled={pending}>
        {pending ? <span className="spinner" aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
        {pending ? 'Registrando…' : 'Registrar perda'}
      </button>
      <p className="hint-box">
        <Info size={15} aria-hidden="true" />
        <span>O PC do bar valida contra o estoque atual e aplica uma única vez. Se o saldo não comportar a perda, ela fica em conflito para você resolver no PC.</span>
      </p>
    </form>
  );
}
