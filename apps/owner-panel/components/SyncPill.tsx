'use client';
import { isStale } from '@rupbar/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ago, fmtFull } from '@/lib/format';

/** Selo "ao vivo" da última sincronização, atualizado sozinho a cada 30 s. */
export function SyncPill({ lastSyncAt, pending, connected, serverNow, compact }: { lastSyncAt: string | null; pending: number; connected: boolean; serverNow: number; compact?: boolean }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!connected) {
    return (
      <Link href="/sincronizacao" className="sync-pill off" title="Nenhum PC do bar conectado">
        <span className="sync-dot" aria-hidden="true" />
        <span>{compact ? 'Sem PC' : 'Nenhum PC conectado'}</span>
      </Link>
    );
  }
  const stale = isStale(lastSyncAt, now);
  const when = lastSyncAt ? ago(lastSyncAt, now) : 'nunca';
  return (
    <Link
      href="/sincronizacao"
      className={`sync-pill ${stale ? 'stale' : 'live'}`}
      title={`Última sincronização: ${fmtFull(lastSyncAt)}${pending ? ` · ${pending} pendência(s) no PC` : ''}`}
    >
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-state">{stale ? 'Desatualizado' : 'Ao vivo'}</span>
      <span className="sync-ago">
        {compact ? when : `sincronizado ${when}`}
      </span>
      {pending && !compact ? <span className="sync-pending">{pending} pendente{pending > 1 ? 's' : ''}</span> : null}
    </Link>
  );
}
