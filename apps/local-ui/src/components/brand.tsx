import { Cloud, CloudOff, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useInterval, useLoad } from '../lib/hooks';
import { useRealtime, useRealtimeStatus } from '../lib/realtime';
import { useSession, type Branding } from '../lib/session';

/** Logotipo do estabelecimento ou placeholder elegante com as iniciais. */
export function Logo({ branding, size = 40 }: { branding: Pick<Branding, 'logoUrl' | 'initials' | 'tradeName'> | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = branding?.initials ?? 'RB';
  return (
    <div className="logo" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-label={branding?.tradeName ?? 'RupBar'}>
      {branding?.logoUrl && !broken ? <img src={branding.logoUrl} alt="" onError={() => setBroken(true)} /> : initials}
    </div>
  );
}

export function RupbarSignature() {
  return (
    <div className="signature">
      <strong>RupBar</strong> by Ruptix
    </div>
  );
}

interface SyncStatus {
  status: 'synced' | 'syncing' | 'offline' | 'pending' | 'error' | 'disabled';
  pending: number;
  lastSuccessAt: string | null;
  error: string | null;
}

const SYNC_UI: Record<SyncStatus['status'], { label: string; dot: string; icon: typeof Cloud }> = {
  synced: { label: 'Sincronizado', dot: 'green', icon: Cloud },
  syncing: { label: 'Sincronizando', dot: 'blue pulse', icon: RefreshCw },
  offline: { label: 'Sem internet', dot: 'orange', icon: CloudOff },
  pending: { label: 'Pendências', dot: 'orange', icon: Cloud },
  error: { label: 'Erro de sincronização', dot: 'red', icon: TriangleAlert },
  disabled: { label: 'Nuvem não configurada', dot: '', icon: CloudOff },
};

/** Indicador de sincronização com a nuvem (barra superior). */
export function SyncIndicator() {
  const { data, reload } = useLoad(() => api.get<SyncStatus>('/api/sync/status'));
  useRealtime('sync.status', () => void reload());
  useInterval(() => void reload(), 30_000);
  if (!data) return null;
  const ui = SYNC_UI[data.status];
  const Icon = ui.icon;
  const title = [ui.label, data.pending ? `${data.pending} pendente(s)` : '', data.lastSuccessAt ? `Última: ${fmtDateTime(data.lastSuccessAt)}` : '', data.error ?? '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="row small muted" title={title} style={{ gap: 6 }}>
      <span className={`dot ${ui.dot}`} />
      <Icon size={15} />
      <span className="hide-mobile">{ui.label}{data.status === 'pending' ? ` (${data.pending})` : ''}</span>
    </div>
  );
}

/** Aviso quando o dispositivo perde a conexão com o PC do bar. */
export function ConnectionBanner() {
  const status = useRealtimeStatus();
  const { user } = useSession();
  const [shown, setShown] = useState(false);
  useInterval(() => setShown(status === 'offline'), 2500);
  if (!user || !shown || status === 'online') return null;
  return (
    <div className="banner warning" style={{ borderRadius: 0, justifyContent: 'center' }}>
      <WifiOff size={18} />
      <span>Reconectando ao PC do bar… Os dados podem estar desatualizados.</span>
    </div>
  );
}
