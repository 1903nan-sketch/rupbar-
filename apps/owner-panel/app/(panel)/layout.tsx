import { initials } from '@rupbar/core';
import { MonitorSmartphone, Settings, Sparkles } from 'lucide-react';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { DiscountInbox } from '@/components/DiscountInbox';
import { Shell } from '@/components/Shell';
import { SyncBanner } from '@/components/SyncBanner';
import { SyncPill } from '@/components/SyncPill';
import { TopbarTitle } from '@/components/TopbarTitle';
import { currentEstablishment, deviceStatus } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const { establishments, est, user } = await currentEstablishment();
  const device = est ? await deviceStatus(est.id) : null;
  const collapsed = (await cookies()).get('rupbar_sidebar')?.value === 'collapsed';
  const tradeName = est?.trade_name ?? 'RupBar';
  const short = initials(tradeName);
  const email = user.email ?? '';

  const topbar = (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="avatar sm" aria-hidden="true">
          {short}
        </div>
        <span className="ellipsis">{tradeName}</span>
      </div>
      <TopbarTitle tradeName={tradeName} />
      <div className="grow" />
      {est ? <SyncPill lastSyncAt={device?.last_sync_at ?? null} pending={device?.pending_count ?? 0} connected={!!device} serverNow={Date.now()} /> : null}
      {email ? (
        <div className="topbar-user" title={email}>
          <span className="user-avatar" aria-hidden="true">
            {email.slice(0, 1).toUpperCase()}
          </span>
          <span className="ellipsis">{email}</span>
        </div>
      ) : null}
    </header>
  );

  return (
    <Shell initialCollapsed={collapsed} tradeName={tradeName} initials={short} establishments={establishments} currentId={est?.id ?? null} email={email} topbar={topbar}>
      {est ? (
        <>
          <SyncBanner device={device} />
          <DiscountInbox />
          {children}
        </>
      ) : (
        <section className="card welcome">
          <span className="welcome-icon" aria-hidden="true">
            <Sparkles size={28} />
          </span>
          <h1>Bem-vindo ao painel do RupBar</h1>
          <p className="muted">
            Ainda não há estabelecimento vinculado a esta conta. Os dados aparecerão aqui após a primeira sincronização.
          </p>
          <ol className="steps">
            <li>
              <span className="step-icon" aria-hidden="true">
                <MonitorSmartphone size={18} />
              </span>
              <span>No computador do bar, abra o RupBar.</span>
            </li>
            <li>
              <span className="step-icon" aria-hidden="true">
                <Settings size={18} />
              </span>
              <span>
                Vá em <strong>Configurações → Sincronização</strong> e conecte usando este e-mail ({email}).
              </span>
            </li>
          </ol>
        </section>
      )}
    </Shell>
  );
}
