import { initials } from '@rupbar/core';
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { SyncBanner } from '@/components/SyncBanner';
import { currentEstablishment, deviceStatus } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const { establishments, est, user } = await currentEstablishment();
  const device = est ? await deviceStatus(est.id) : null;
  return (
    <div className="shell">
      <Sidebar tradeName={est?.trade_name ?? 'RupBar'} initials={initials(est?.trade_name ?? 'RupBar')} establishments={establishments} currentId={est?.id ?? null} />
      <div className="main">
        <header className="topbar glass">
          <div className="grow"><SyncBanner device={device} /></div>
          <span className="small muted">{user.email}</span>
        </header>
        <main className="content">
          {est ? children : (
            <div className="card stack">
              <h2>Bem-vindo ao painel do RupBar</h2>
              <p className="muted">Ainda não há estabelecimento vinculado a esta conta. No computador do bar, abra <strong>Configurações → Sincronização</strong> e conecte usando este e-mail ({user.email}). Os dados aparecerão aqui após a primeira sincronização.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
