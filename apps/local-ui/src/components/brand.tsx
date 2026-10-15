import { Cloud, CloudOff, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { useRef, useState } from 'react';
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

/**
 * Indicador de sincronização com a nuvem (barra superior). Fica calmo:
 *  - verde fixo enquanto a nuvem está em dia (envios rotineiros não piscam);
 *  - vermelho quando cai (sem internet ou erro);
 *  - azul só ao voltar de uma queda, enquanto envia o que ficou pendente.
 */
type SyncLook = 'ok' | 'recovering' | 'down' | 'off';

const LOOK: Record<SyncLook, { label: string; dot: string; icon: typeof Cloud }> = {
  ok: { label: 'Sincronizado', dot: 'green', icon: Cloud },
  recovering: { label: 'Sincronizando', dot: 'blue', icon: RefreshCw },
  down: { label: 'Sem conexão com a nuvem', dot: 'red', icon: CloudOff },
  off: { label: 'Nuvem não configurada', dot: '', icon: CloudOff },
};

export function SyncIndicator() {
  const { data, reload } = useLoad(() => api.get<SyncStatus>('/api/sync/status'));
  useRealtime('sync.status', () => void reload());
  useInterval(() => void reload(), 30_000);
  const recovering = useRef(false);
  if (!data) return null;
  let look: SyncLook;
  if (data.status === 'disabled') look = 'off';
  else if (data.status === 'offline' || data.status === 'error') {
    recovering.current = true;
    look = 'down';
  } else if (data.status === 'synced') {
    recovering.current = false;
    look = 'ok';
  } else look = recovering.current ? 'recovering' : 'ok';
  const ui = LOOK[look];
  const Icon = data.status === 'error' ? TriangleAlert : ui.icon;
  const title = [ui.label, data.pending ? `${data.pending} na fila` : '', data.lastSuccessAt ? `Última: ${fmtDateTime(data.lastSuccessAt)}` : '', data.error ?? '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`row small sync-indicator ${look}`} title={title} style={{ gap: 6 }}>
      <span className={`dot ${ui.dot}`} />
      <Icon size={15} className={look === 'recovering' ? 'spin-slow' : undefined} />
      <span className="hide-mobile">{ui.label}</span>
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
