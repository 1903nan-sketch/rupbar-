'use client';
import { formatBRL } from '@rupbar/core';
import { CircleAlert, CircleCheck, Lock, Trash2, X } from 'lucide-react';
import { startTransition, useActionState, useState } from 'react';
import { deleteItems, verifyDeletePin, type ActionState } from '../acoes';

export interface DeletableItem { id: string; label: string; priceCents: number }

/**
 * Lixeira da comanda: um ícone de lixeira pequeno que pede a senha, abre o modo
 * de seleção (vai clicando nos itens) e apaga — devolvendo ao estoque ou como
 * consumo/cortesia. O item vira cancelado e fica registrado na Lixeira.
 */
export function DeleteItems({ comandaLabel, items }: { comandaLabel: string; items: DeletableItem[] }) {
  const [open, setOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState('');
  const [checking, setChecking] = useState(false);
  const [pinError, setPinError] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [keepStock, setKeepStock] = useState(true); // cortesia (mantém baixa) por padrão
  const [state, run, busy] = useActionState<ActionState | null, FormData>(deleteItems, null);

  const close = () => { setOpen(false); setUnlocked(false); setPin(''); setPinError(''); setSel(new Set()); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selected = items.filter((i) => sel.has(i.id));
  const totalSel = selected.reduce((a, i) => a + i.priceCents, 0);

  const unlock = async () => {
    setChecking(true); setPinError('');
    try {
      if (await verifyDeletePin(pin)) setUnlocked(true);
      else setPinError('Senha incorreta.');
    } finally { setChecking(false); }
  };

  const submit = () => {
    if (!selected.length || busy) return;
    const data = new FormData();
    data.set('pin', pin);
    data.set('returnToStock', keepStock ? '0' : '1');
    data.set('items', JSON.stringify(selected.map((i) => ({ id: i.id, label: i.label }))));
    startTransition(() => run(data));
  };

  if (!open) {
    return (
      <button type="button" className="btn ghost icon btn-trash" aria-label="Apagar itens (lixeira)" title="Apagar itens" onClick={() => setOpen(true)}>
        <Trash2 size={16} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="pin-overlay" role="dialog" aria-modal="true" aria-label="Apagar itens da comanda">
      <div className="pin-modal">
        <div className="pin-head">
          <strong>{state?.ok ? 'Pronto' : unlocked ? `Apagar itens — ${comandaLabel}` : 'Lixeira'}</strong>
          <button type="button" className="btn ghost icon" aria-label="Fechar" onClick={close}><X size={18} aria-hidden="true" /></button>
        </div>

        {state?.ok ? (
          <div className="stack">
            <div className="banner success"><span className="banner-icon"><CircleCheck size={18} /></span><span>{state.message}</span></div>
            <button type="button" className="btn primary" onClick={close}>Fechar</button>
          </div>
        ) : !unlocked ? (
          <div className="stack">
            <p className="small muted">Digite a senha pra abrir. Sem ela, ninguém apaga nada.</p>
            <div className="input-money">
              <Lock size={16} aria-hidden="true" style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
              <input className="input" style={{ paddingLeft: 40 }} inputMode="numeric" type="password" autoFocus placeholder="Senha" value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setPinError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && unlock()} aria-label="Senha da lixeira" />
            </div>
            {pinError && <p className="small danger-text">{pinError}</p>}
            <button type="button" className="btn primary" disabled={checking || pin.length < 4} onClick={unlock}>
              {checking ? <span className="spinner" aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />} Entrar
            </button>
          </div>
        ) : (
          <div className="stack">
            <p className="small muted">Toque nos itens que quer apagar.</p>
            <ul className="list flush delete-list">
              {items.map((i) => (
                <li key={i.id}>
                  <label className="delete-row">
                    <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} />
                    <span className="grow">{i.label}</span>
                    <span className="num muted">{formatBRL(i.priceCents)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="seg-stock" role="group" aria-label="O que fazer com o estoque">
              <button type="button" className={keepStock ? 'active' : ''} onClick={() => setKeepStock(true)}>Consumido / cortesia<span className="tiny">estoque continua baixado</span></button>
              <button type="button" className={!keepStock ? 'active' : ''} onClick={() => setKeepStock(false)}>Foi engano<span className="tiny">devolve ao estoque</span></button>
            </div>
            {state && !state.ok && <div className="banner danger"><span className="banner-icon"><CircleAlert size={18} /></span><span>{state.message}</span></div>}
            <button type="button" className="btn danger" disabled={!selected.length || busy} onClick={submit}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
              {selected.length ? `Apagar ${selected.length === 1 ? '1 item' : `${selected.length} itens`} (${formatBRL(totalSel)})` : 'Selecione os itens'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
