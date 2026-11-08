'use client';
import { formatBRL } from '@rupbar/core';
import { Lock, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { deletedItems, type DeletedItem } from '../acoes';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—');

export function LixeiraView() {
  const [pin, setPin] = useState('');
  const [rows, setRows] = useState<DeletedItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const open = async () => {
    setBusy(true); setError('');
    try {
      const r = await deletedItems(pin);
      if (r === null) setError('Senha incorreta.');
      else setRows(r);
    } finally { setBusy(false); }
  };

  if (rows === null) {
    return (
      <section className="card glow lixeira-lock">
        <div className="stack">
          <p className="small muted">Digite a senha da Lixeira para ver o histórico.</p>
          <input className="input" type="password" inputMode="numeric" autoFocus placeholder="Senha" aria-label="Senha da lixeira" value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} onKeyDown={(e) => e.key === 'Enter' && open()} />
          {error && <p className="small danger-text">{error}</p>}
          <button type="button" className="btn primary" disabled={busy || pin.length < 4} onClick={open}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />} Abrir Lixeira
          </button>
        </div>
      </section>
    );
  }

  const total = rows.reduce((a, r) => a + r.valueCents, 0);
  return (
    <section className="card glow flush">
      <header className="card-head">
        <span className="icon-chip rose" aria-hidden="true"><Trash2 size={16} /></span>
        <div className="grow">
          <h2 className="card-title">{rows.length === 1 ? '1 item apagado' : `${rows.length} itens apagados`}</h2>
          <p className="card-sub">Total {formatBRL(total)} · os mais recentes primeiro</p>
        </div>
      </header>
      {!rows.length ? <p className="small muted" style={{ padding: 20 }}>Nada na Lixeira.</p> : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id} className="list-item lixeira-row">
              <div className="grow">
                <div className="strong">{r.name}</div>
                <div className="tiny muted">{r.comanda} · {when(r.at)}{r.by ? ` · ${r.by}` : ''}</div>
                {r.reason && <div className="tiny">{r.reason}</div>}
              </div>
              <span className="num">{formatBRL(r.valueCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
