'use client';
import { LOSS_REASONS, type LossReason } from '@rupbar/core';
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
    <form action={action} className="stack">
      <div className="field">
        <label htmlFor="productId">Produto</label>
        <select id="productId" name="productId" className="select" required value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">Selecione…</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="grid-2">
        <div className="field"><label htmlFor="amount">Quantidade</label><input id="amount" name="amount" className="input" inputMode="decimal" required /></div>
        <div className="field"><label htmlFor="unit">Unidade</label>
          <select id="unit" name="unit" className="select" key={measure}>{UNITS[measure]!.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}</select>
        </div>
      </div>
      <div className="grid-2">
        <div className="field"><label htmlFor="reason">Motivo</label>
          <select id="reason" name="reason" className="select" required defaultValue="broken">{(Object.keys(LOSS_REASONS) as LossReason[]).map((r) => <option key={r} value={r}>{LOSS_REASONS[r]}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="occurredAt">Data e horário</label><input id="occurredAt" name="occurredAt" type="datetime-local" className="input" /></div>
      </div>
      <div className="field"><label htmlFor="notes">Observações</label><textarea id="notes" name="notes" className="textarea" maxLength={400} /></div>
      {state && <div className={`banner ${state.ok ? 'success' : 'danger'}`}>{state.message}</div>}
      <button className="btn primary" type="submit" disabled={pending}>{pending ? 'Registrando…' : 'Registrar perda'}</button>
      <p className="tiny muted">O PC do bar valida contra o estoque atual e aplica uma única vez. Se o saldo não comportar a perda, ela fica em conflito para você resolver no PC.</p>
    </form>
  );
}
