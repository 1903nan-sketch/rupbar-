import { REMOTE_COMMAND_LABELS, type RemoteCommandType } from '@rupbar/core';
import { CloudUpload, Download, WifiOff } from 'lucide-react';
import { cancelCommand } from '@/app/(panel)/acoes';
import { AutoRefresh } from './AutoRefresh';
import { Badge, Card, Empty, type BadgeColor } from './ui';
import { currentEstablishment, deviceStatus, OWNER_ACTIONS_VERSION, versionAtLeast } from '@/lib/data';
import { fmtShort } from '@/lib/format';

const STATUS: Record<string, [string, BadgeColor]> = {
  pending: ['Aguardando o PC', 'orange'],
  delivered: ['Aplicando no PC', 'orange'],
  applied: ['Feito', 'green'],
  conflict: ['Recusado', 'red'],
  rejected: ['Recusado', 'red'],
  canceled: ['Cancelado', 'gray'],
};

/**
 * Ações enviadas pelo painel e o que o PC do bar respondeu. Enquanto houver
 * ação esperando, a página se atualiza sozinha a cada poucos segundos.
 */
export async function CommandFeed({ types, path, title = 'Ações enviadas', limit = 8 }: { types: RemoteCommandType[]; path: string; title?: string; limit?: number }) {
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const [{ data }, device] = await Promise.all([
    sb.from('remote_commands').select('id, type, status, payload, result, created_at').eq('establishment_id', est.id).in('type', types)
      .order('created_at', { ascending: false }).limit(limit),
    deviceStatus(est.id),
  ]);
  const commands = data ?? [];
  const waiting = commands.filter((c) => c.status === 'pending' || c.status === 'delivered');
  const seenAgo = device?.last_seen_at ? Date.now() - new Date(device.last_seen_at).getTime() : Infinity;
  const offline = waiting.length > 0 && seenAgo > 2 * 60_000;
  const outdated = !!device && !versionAtLeast(device.app_version, OWNER_ACTIONS_VERSION);
  return (
    <Card title={title} subtitle={waiting.length ? `${waiting.length} esperando o PC do bar` : 'O PC do bar confere e aplica cada ação'} icon={CloudUpload} tone="blue" flush>
      {waiting.length > 0 && <AutoRefresh seconds={4} />}
      {outdated && (
        <div className="banner warning feed-banner" role="status">
          <span className="banner-icon" aria-hidden="true"><Download size={18} /></span>
          <span>
            O PC do bar está com o RupBar {device?.app_version ?? 'antigo'}. Para abrir comanda, lançar item, abrir ou fechar o caixa daqui, instale a atualização no PC do bar.
          </span>
        </div>
      )}
      {offline && (
        <div className="banner warning feed-banner" role="status">
          <span className="banner-icon" aria-hidden="true"><WifiOff size={18} /></span>
          <span>O PC do bar está sem conexão. As ações ficam na fila e são aplicadas quando ele voltar a se conectar.</span>
        </div>
      )}
      {!commands.length ? (
        <Empty title="Nenhuma ação enviada" icon={CloudUpload}>O que você fizer por aqui aparece nesta lista com a resposta do PC do bar.</Empty>
      ) : (
        <ul className="list">
          {commands.map((c) => {
            const [label, color] = STATUS[c.status as string] ?? [c.status as string, 'gray' as const];
            const payload = c.payload as { label?: string } | null;
            const raw = (c.result as { message?: string } | null)?.message;
            // PC antigo: não conhece a ação e recusa com "Comando desconhecido".
            const msg = raw?.startsWith('Comando desconhecido') ? 'O PC do bar precisa da atualização do RupBar para esta ação.' : raw;
            const busy = c.status === 'pending' || c.status === 'delivered';
            return (
              <li key={c.id as string} className="list-item feed-item">
                <div className="grow">
                  <div className="strong">{payload?.label || REMOTE_COMMAND_LABELS[c.type as RemoteCommandType] || (c.type as string)}</div>
                  <div className={`tiny ${c.status === 'rejected' || c.status === 'conflict' ? 'danger-text' : 'muted'}`}>
                    {fmtShort(c.created_at as string)}{msg ? ` · ${msg}` : ''}
                  </div>
                </div>
                <Badge color={color} dot pulse={busy}>{label}</Badge>
                {c.status === 'pending' && (
                  <form action={cancelCommand}>
                    <input type="hidden" name="id" value={c.id as string} />
                    <input type="hidden" name="path" value={path} />
                    <button className="btn ghost small" type="submit">Cancelar</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
