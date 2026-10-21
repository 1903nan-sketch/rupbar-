'use client';
import { formatBRL } from '@rupbar/core';
import { CircleAlert, CircleCheck, Minus, Plus, Search, Send, Trash2, X } from 'lucide-react';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { cancelItem, launchItems, type ActionState } from '../acoes';

export interface SaleOption {
  presentationId: string;
  name: string;
  category: string;
  priceCents: number;
}

/** Lançar itens numa comanda pelo painel: busca, quantidade e envio para o PC do bar. */
export function ItemLauncher({ comandaId, comandaLabel, options }: { comandaId: string; comandaLabel: string; options: SaleOption[] }) {
  const [state, action, busy] = useActionState<ActionState | null, FormData>(launchItems, null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Record<string, number>>({});
  useEffect(() => {
    if (state?.ok) setPicked({});
  }, [state]);
  const term = q.trim().toLocaleLowerCase('pt-BR');
  const found = useMemo(() => (term ? options.filter((o) => `${o.name} ${o.category}`.toLocaleLowerCase('pt-BR').includes(term)) : options).slice(0, 40), [options, term]);
  const lines = options.filter((o) => picked[o.presentationId]);
  const total = lines.reduce((a, o) => a + o.priceCents * picked[o.presentationId]!, 0);
  const add = (id: string, n: number) => setPicked((p) => {
    const next = { ...p, [id]: Math.min(99, (p[id] ?? 0) + n) };
    if (next[id]! <= 0) delete next[id];
    return next;
  });

  return (
    <form action={action} className="stack launcher">
      <input type="hidden" name="comandaId" value={comandaId} />
      <input type="hidden" name="comandaLabel" value={comandaLabel} />
      <input type="hidden" name="items" value={JSON.stringify(lines.map((o) => ({ presentationId: o.presentationId, quantity: picked[o.presentationId], name: o.name })))} />
      <div className="input-icon">
        <Search size={16} aria-hidden="true" />
        <input className="input" placeholder="Buscar produto (ex.: heineken, dose, porção)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar produto para lançar" />
      </div>
      <ul className="launcher-results" aria-label="Produtos">
        {found.map((o) => (
          <li key={o.presentationId}>
            <button type="button" className="launcher-option" onClick={() => add(o.presentationId, 1)} aria-label={`Adicionar ${o.name}`}>
              <span className="grow">
                <span className="strong">{o.name}</span>
                <span className="tiny muted">{o.category}</span>
              </span>
              <span className="num small">{formatBRL(o.priceCents)}</span>
              <Plus size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
        {!found.length && <li className="tiny muted">Nada encontrado.</li>}
      </ul>
      {lines.length > 0 && (
        <ul className="list launcher-picked" aria-label="Itens a lançar">
          {lines.map((o) => (
            <li key={o.presentationId} className="list-item">
              <div className="launcher-stepper">
                <button type="button" className="btn ghost small icon" onClick={() => add(o.presentationId, -1)} aria-label={`Menos ${o.name}`}><Minus size={14} /></button>
                <span className="num strong">{picked[o.presentationId]}</span>
                <button type="button" className="btn ghost small icon" onClick={() => add(o.presentationId, 1)} aria-label={`Mais ${o.name}`}><Plus size={14} /></button>
              </div>
              <span className="grow small">{o.name}</span>
              <span className="num small">{formatBRL(o.priceCents * picked[o.presentationId]!)}</span>
              <button type="button" className="btn ghost small icon" onClick={() => add(o.presentationId, -99)} aria-label={`Tirar ${o.name}`}><Trash2 size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <button className="btn primary large block" type="submit" disabled={busy || !lines.length}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
        {busy ? 'Enviando…' : lines.length ? `Lançar ${lines.reduce((a, o) => a + picked[o.presentationId]!, 0)} item(ns) · ${formatBRL(total)}` : 'Escolha os itens'}
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

/** Tirar um item da comanda: pede o motivo e envia para o PC do bar. */
export function CancelItemButton({ itemId, itemLabel }: { itemId: string; itemLabel: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, busy] = useActionState<ActionState | null, FormData>(cancelItem, null);
  if (state?.ok) return <span className="tiny muted">Enviado</span>;
  if (!open) {
    return <button type="button" className="btn ghost small" onClick={() => setOpen(true)} aria-label={`Tirar ${itemLabel}`}>Tirar</button>;
  }
  return (
    <form action={action} className="cancel-item">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="itemLabel" value={itemLabel} />
      <input className="input" name="reason" placeholder="Motivo (ex.: lançado errado)" autoFocus aria-label={`Motivo para tirar ${itemLabel}`} required minLength={3} maxLength={200} />
      <button className="btn danger small" type="submit" disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : 'Tirar'}</button>
      <button type="button" className="btn ghost small icon" onClick={() => setOpen(false)} aria-label="Cancelar"><X size={14} /></button>
      {state && !state.ok && <span className="tiny danger-text">{state.message}</span>}
    </form>
  );
}
