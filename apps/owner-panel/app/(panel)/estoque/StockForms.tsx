'use client';
import {
  bigUnitName, buyModeOf, costPer, describeEntry, formatBRL, formatQty, KILO, MILLI, packName, qtyFrom, unitName,
  type Measure, type Packaging, type QtyMode,
} from '@rupbar/core';
import { CircleAlert, CircleCheck, ClipboardCheck, PackagePlus } from 'lucide-react';
import { startTransition, useActionState, useEffect, useState, type ReactNode } from 'react';
import { stockAdjust, stockEntry, updateMinStock, type ActionState } from '../acoes';

export interface StockProduct {
  id: string;
  name: string;
  measure: Measure;
  packageQty: number;
  packageLabel: string | null;
  unitLabel: string | null;
  stockQty: number;
  minStock: number;
}

const cap = (s: string) => (s ? s[0]!.toLocaleUpperCase('pt-BR') + s.slice(1) : s);

/** "1,5" → 1.5 · "1.000,50" → 1000.5 · "" → null. */
function parseNumber(raw: string): number | null {
  const s = raw.replace(/\s/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const toCents = (raw: string) => {
  const n = parseNumber(raw.replace(/r\$/i, ''));
  return n === null ? null : Math.round(n * 100);
};

/** Em que dá para digitar: fardos | latas, garrafas | ml | L, pacotes | g | kg. */
function modesFor(pk: Packaging): QtyMode[] {
  if (buyModeOf(pk) === 'single') return ['unit'];
  return pk.measure === 'unit' ? ['pack', 'unit'] : ['pack', 'unit', 'kilo'];
}
function modeLabel(mode: QtyMode, pk: Packaging): string {
  if (mode === 'pack') return cap(packName(pk, 2));
  if (mode === 'kilo') return bigUnitName(pk.measure) ?? 'un';
  return pk.measure === 'unit' ? cap(unitName(pk, 2)) : unitName(pk, 2);
}
/** Pacote de insumo (g): em kg; fardo e garrafa: em embalagens; avulso: em unidades. */
function defaultMode(pk: Packaging): QtyMode {
  const buy = buyModeOf(pk);
  return buy === 'single' ? 'unit' : buy === 'bag' ? 'kilo' : 'pack';
}

function useQty(pk: Packaging) {
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<QtyMode>(defaultMode(pk));
  const amount = parseNumber(raw);
  return { raw, setRaw, mode, setMode, amount, qty: amount === null ? null : qtyFrom(amount, mode, pk), reset: () => setRaw('') };
}

function QtyInput({ id, label, pk, q, hint }: { id: string; label: string; pk: Packaging; q: ReturnType<typeof useQty>; hint?: ReactNode }) {
  const modes = modesFor(pk);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="qty-row">
        <input id={id} className="input" inputMode="decimal" placeholder="0" value={q.raw} onChange={(e) => q.setRaw(e.target.value)} />
        {modes.length > 1 ? (
          <select className="select" aria-label={`${label}: contar em`} value={q.mode} onChange={(e) => q.setMode(e.target.value as QtyMode)}>
            {modes.map((m) => <option key={m} value={m}>{modeLabel(m, pk)}</option>)}
          </select>
        ) : (
          <span className="qty-unit muted">{modeLabel('unit', pk)}</span>
        )}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Formulário enviado à mão: o React não limpa os campos; depois do envio eles zeram. */
function Section({ title, icon, action, submit, ready, confirmText, onSent, children }: {
  title: string; icon: ReactNode; action: (prev: ActionState | null, form: FormData) => Promise<ActionState>;
  submit: string; ready: boolean; confirmText?: string; onSent: () => void; children: ReactNode;
}) {
  const [state, run, busy] = useActionState<ActionState | null, FormData>(action, null);
  useEffect(() => {
    if (state?.ok) onSent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form
      className="stack stock-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || (confirmText && !window.confirm(confirmText))) return;
        const data = new FormData(e.currentTarget);
        startTransition(() => run(data));
      }}
    >
      <h3 className="mini-label">{title}</h3>
      {children}
      <button className="btn primary" type="submit" disabled={busy || !ready}>
        {busy ? <span className="spinner" aria-hidden="true" /> : icon}
        {busy ? 'Enviando…' : submit}
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

/** Entrada, contagem (corrigir saldo) e estoque mínimo de um produto, enviados ao PC do bar. */
export function StockForms({ product }: { product: StockProduct }) {
  const pk: Packaging = { measure: product.measure, packageQty: product.packageQty, packageLabel: product.packageLabel, unitLabel: product.unitLabel };
  const fmt = (qty: number) => formatQty(qty, product.measure).replace(/ un$/, ` ${unitName(pk, qty / MILLI)}`);
  const entry = useQty(pk);
  const [paid, setPaid] = useState('');
  const [invoice, setInvoice] = useState('');
  const counted = useQty(pk);
  const [reason, setReason] = useState('');
  const min = useQty(pk);

  const paidCents = toCents(paid);
  const entryText = entry.amount && entry.qty ? describeEntry(entry.amount, entry.mode, pk) : null;
  const ref = pk.measure === 'unit' ? MILLI : KILO;
  const perUnit = paidCents !== null && entry.qty ? costPer(paidCents, entry.qty, ref) : null;
  const diff = counted.qty === null ? null : counted.qty - product.stockQty;

  return (
    <div className="stock-forms">
      <Section title="Dar entrada" icon={<PackagePlus size={17} aria-hidden="true" />} action={stockEntry}
        submit={entry.qty ? `Dar entrada de ${fmt(entry.qty)}` : 'Dar entrada'} ready={!!entry.qty && entry.qty > 0 && paidCents !== null}
        onSent={() => { entry.reset(); setPaid(''); setInvoice(''); }}>
        <input type="hidden" name="productId" value={product.id} />
        <input type="hidden" name="productName" value={product.name} />
        <input type="hidden" name="qty" value={entry.qty ?? ''} />
        <input type="hidden" name="qtyText" value={entry.qty ? fmt(entry.qty) : ''} />
        <div className="grid-2 tight">
          <QtyInput id={`entry-${product.id}`} label="Quanto chegou" pk={pk} q={entry} />
          <div className="field">
            <label htmlFor={`paid-${product.id}`}>Quanto pagou (total)</label>
            <input id={`paid-${product.id}`} name="totalCost" className="input" inputMode="decimal" placeholder="0,00" value={paid} onChange={(e) => setPaid(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`nf-${product.id}`}>Nota fiscal (opcional)</label>
          <input id={`nf-${product.id}`} name="invoice" className="input" maxLength={40} value={invoice} onChange={(e) => setInvoice(e.target.value)} />
        </div>
        <p className="small muted entry-preview" aria-live="polite">
          {entryText ? (
            <>
              Entrando <strong>{entryText.lead}</strong>{entryText.equals.map((x) => <span key={x}> = <strong>{x}</strong></span>)}. Fica {fmt(product.stockQty + entry.qty!)}.
              {perUnit !== null && <> Custo por {pk.measure === 'unit' ? unitName(pk, 1) : bigUnitName(pk.measure)}: <strong>{formatBRL(perUnit)}</strong>.</>}
            </>
          ) : `Saldo agora: ${fmt(product.stockQty)}.`}
        </p>
      </Section>

      <Section title="Corrigir saldo (contagem)" icon={<ClipboardCheck size={17} aria-hidden="true" />} action={stockAdjust}
        submit="Corrigir saldo" ready={counted.qty !== null && diff !== 0 && reason.trim().length >= 3}
        confirmText={counted.qty !== null ? `Corrigir o saldo de ${product.name} de ${fmt(product.stockQty)} para ${fmt(counted.qty)}?` : undefined}
        onSent={() => { counted.reset(); setReason(''); }}>
        <input type="hidden" name="productId" value={product.id} />
        <input type="hidden" name="productName" value={product.name} />
        <input type="hidden" name="countedQty" value={counted.qty ?? ''} />
        <input type="hidden" name="qtyText" value={counted.qty !== null ? fmt(counted.qty) : ''} />
        <div className="grid-2 tight">
          <QtyInput id={`count-${product.id}`} label="Quanto tem agora (contado)" pk={pk} q={counted} />
          <div className="field">
            <label htmlFor={`reason-${product.id}`}>Motivo</label>
            <input id={`reason-${product.id}`} name="reason" className="input" maxLength={200} placeholder="Ex.: contagem do fim de semana" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <p className="small muted" aria-live="polite">
          {diff === null ? `Saldo no sistema: ${fmt(product.stockQty)}.` : diff === 0 ? 'Igual ao saldo do sistema.' : (
            <>
              {fmt(product.stockQty)} → <strong>{fmt(counted.qty!)}</strong> ({diff > 0 ? '+' : '−'}{fmt(Math.abs(diff))}).
            </>
          )}
        </p>
      </Section>

      <Section title="Estoque mínimo" icon={<CircleAlert size={17} aria-hidden="true" />} action={updateMinStock}
        submit="Salvar mínimo" ready={min.qty !== null && min.qty !== product.minStock} onSent={() => min.reset()}>
        <input type="hidden" name="productId" value={product.id} />
        <input type="hidden" name="productName" value={product.name} />
        <input type="hidden" name="minStock" value={min.qty ?? ''} />
        <input type="hidden" name="qtyText" value={min.qty !== null ? fmt(min.qty) : ''} />
        <QtyInput id={`min-${product.id}`} label="Avisar quando ficar em" pk={pk} q={min}
          hint={product.minStock ? `Hoje: ${fmt(product.minStock)}. Zero tira o aviso.` : 'Hoje sem mínimo. O alerta aparece no PC e aqui quando chegar nele.'} />
      </Section>
    </div>
  );
}
