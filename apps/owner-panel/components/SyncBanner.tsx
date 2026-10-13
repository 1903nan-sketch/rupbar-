import { isStale } from '@rupbar/core';
import { CloudOff, RefreshCw } from 'lucide-react';
import type { DeviceStatus } from '@/lib/data';

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}

/** Horário da última sincronização e alerta de dados desatualizados. */
export function SyncBanner({ device }: { device: DeviceStatus | null }) {
  if (!device) {
    return (
      <div className="stale"><CloudOff size={18} /> Nenhum PC conectado. No RupBar do bar, abra Configurações → Sincronização e conecte com este e-mail.</div>
    );
  }
  const stale = isStale(device.last_sync_at);
  const when = device.last_sync_at ? new Date(device.last_sync_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'nunca';
  if (stale) {
    return (
      <div className="stale">
        <CloudOff size={18} />
        <span>Dados possivelmente desatualizados: o PC do bar sincronizou pela última vez {device.last_sync_at ? ago(device.last_sync_at) : 'nunca'} ({when}). O bar continua operando offline; os dados chegam quando a internet voltar.</span>
      </div>
    );
  }
  return (
    <div className="row small muted"><RefreshCw size={14} /> Última sincronização {ago(device.last_sync_at!)} ({when}){device.pending_count ? ` · ${device.pending_count} pendência(s) no PC` : ''}</div>
  );
}
