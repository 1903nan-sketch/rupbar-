'use client';
import { formatBRL, PAYMENT_METHODS, type PaymentMethod } from '@rupbar/core';
import { CircleAlert, CircleCheck, Lock, Plus, Trash2 } from 'lucide-react';
import { startTransition, useActionState, useState } from 'react';
import { closeComanda, type ActionState } from '../acoes';

interface Line { method: PaymentMethod; raw: string }

/** "45,00" / "45" / "1.234,56" → centavos (null se inválido). */
function toCents(raw: string): number | null {
  const s = raw.replace(/r\$/i, '').replace(/\s/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
const toRaw = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/**
 * Encerrar a comanda pelo painel: recebe o que falta (uma ou mais formas de
 * pagamento) e encerra. O PC do bar confere o saldo de novo e faz tudo de uma vez.
 */
export function CloseComanda({ comandaId, comandaLabel, remainingCents, staff, cashOpen }: {
  comandaId: string; comandaLabel: string; remainingCents: number; staff: boolean; cashOpen: boolean;
}) {
  const [state, action, busy] = useActionState<ActionState | null, FormData>(closeComanda, null);
  const due = staff ? 0 : Math.max(0, remainingCents);
  const [lines, setLines] = useState<Line[]>(() => (due > 0 ? [{ method: 'pix', raw: toRaw(due) }] : []));
  const parsed = lines.map((l) => ({ ...l, cents: toCents(l.raw) }));
  const sum = parsed.reduce((a, l) => a + (l.cents ?? 0), 0);
  const diff = due - sum;
  const invalid = parsed.some((l) => !l.cents);
  const cashBlocked = !cashOpen && parsed.some((l) => l.method === 'cash');
  const ready = due === 0 || (diff === 0 && !invalid && !cashBlocked);
  const how = parsed.filter((l) => l.cents).map((l) => `${PAYMENT_METHODS[l.method]} ${formatBRL(l.cents!)}`).join(' + ');
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // Enviado: some o formulário (evita mandar duas vezes); a comanda aparece encerrada quando o PC aplicar.
  const sent = state?.ok === true;

  return (
    <form
      action={action}
      className="stack close-comanda"
      onSubmit={(e) => {
        // Envio manual: o React não limpa os campos (a forma de pagamento escolhida continua na tela).
        e.preventDefault();
        const what = due === 0 ? `Encerrar a ${comandaLabel}${staff ? ' (consumo de funcionário, sem cobrança)' : ''}?` : `Encerrar a ${comandaLabel} recebendo ${formatBRL(due)} (${how})?`;
        if (!ready || sent || !window.confirm(`${what}\n\nO PC do bar registra e encerra em alguns segundos.`)) return;
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="comandaId" value={comandaId} />
      <input type="hidden" name="comandaLabel" value={comandaLabel} />
      <input type="hidden" name="remainingCents" value={due} />
      <input type="hidden" name="payments" value={JSON.stringify(parsed.filter((l) => l.cents).map((l) => ({ method: l.method, amountCents: l.cents })))} />

      {sent ? null : staff ? (
        <p className="small muted">Consumo de funcionário não é cobrado: é só encerrar.</p>
      ) : due === 0 ? (
        <p className="small muted">Já está tudo pago. É só encerrar.</p>
      ) : (
        <>
          {lines.map((l, i) => (
            <div key={i} className="close-line">
              <select className="select" aria-label={`Forma de pagamento ${i + 1}`} value={l.method} onChange={(e) => set(i, { method: e.target.value as PaymentMethod })}>
                {(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((m) => (
                  <option key={m} value={m} disabled={m === 'cash' && !cashOpen}>{PAYMENT_METHODS[m]}{m === 'cash' && !cashOpen ? ' (caixa fechado)' : ''}</option>
                ))}
              </select>
              <div className="input-money">
                <span aria-hidden="true">R$</span>
                <input className="input" inputMode="decimal" aria-label={`Valor ${i + 1}`} value={l.raw} onChange={(e) => set(i, { raw: e.target.value })} />
              </div>
              {lines.length > 1 && (
                <button type="button" className="btn ghost icon" aria-label={`Tirar forma de pagamento ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn ghost small close-add" onClick={() => setLines([...lines, { method: lines[0]?.method === 'pix' ? 'credit' : 'pix', raw: toRaw(Math.max(0, diff)) }])}>
            <Plus size={15} aria-hidden="true" /> Dividir em outra forma
          </button>
          <p className={`small ${diff === 0 && !invalid ? 'success-text' : 'danger-text'}`} aria-live="polite">
            {invalid ? 'Confira os valores.' : diff === 0 ? `Fecha certinho: ${formatBRL(due)}.` : diff > 0 ? `Ainda falta ${formatBRL(diff)}.` : `Passou ${formatBRL(-diff)} do que falta (${formatBRL(due)}).`}
          </p>
          {!cashOpen && <p className="tiny muted">O caixa do PC está fechado: dinheiro não entra. Abra o caixa em Caixas ou receba em Pix/cartão.</p>}
        </>
      )}

      {!sent && <button className="btn primary large" type="submit" disabled={busy || !ready}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Lock size={17} aria-hidden="true" />}
        {busy ? 'Enviando…' : due === 0 ? 'Encerrar comanda' : `Receber ${formatBRL(due)} e encerrar`}
      </button>}
      {state && (
        <div className={`banner ${state.ok ? 'success' : 'danger'}`} role={state.ok ? 'status' : 'alert'}>
          <span className="banner-icon" aria-hidden="true">{state.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}</span>
          <span>{state.message}</span>
        </div>
      )}
    </form>
  );
}
