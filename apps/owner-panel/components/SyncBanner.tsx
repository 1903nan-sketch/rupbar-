import { isStale } from '@rupbar/core';
import { CloudOff, PlugZap } from 'lucide-react';
import Link from 'next/link';
import type { DeviceStatus } from '@/lib/data';
import { ago, fmtFull } from '@/lib/format';

/**
 * Aviso de dados desatualizados (ou de nenhum PC conectado). Quando tudo está
 * em dia não mostra nada: o selo "ao vivo" da barra superior basta.
 */
export function SyncBanner({ device }: { device: DeviceStatus | null }) {
  if (!device) {
    return (
      <Link href="/sincronizacao" className="banner warning">
        <span className="banner-icon" aria-hidden="true">
          <PlugZap size={18} />
        </span>
        <span>
          <strong>Nenhum PC conectado.</strong> No RupBar do bar, abra Configurações → Sincronização e conecte com este e-mail.
        </span>
      </Link>
    );
  }
  if (!isStale(device.last_sync_at)) return null;
  return (
    <div className="banner warning" role="status">
      <span className="banner-icon" aria-hidden="true">
        <CloudOff size={18} />
      </span>
      <span>
        <strong>Dados possivelmente desatualizados:</strong> o PC do bar sincronizou pela última vez {device.last_sync_at ? ago(device.last_sync_at) : 'nunca'} ({fmtFull(device.last_sync_at)}). O bar continua operando offline; os dados chegam quando a internet voltar.
      </span>
    </div>
  );
}
