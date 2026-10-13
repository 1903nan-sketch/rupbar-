import { isStale } from '@rupbar/core';
import { Cloud, CloudOff, Database, Lock, Monitor, Repeat2, ShieldOff, Timer, Workflow } from 'lucide-react';
import { revalidatePath } from 'next/cache';
import { Badge, Card, Empty, PageHeader, Stat, stagger } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';
import { ago, fmtFull } from '@/lib/format';

export const metadata = { title: 'Sincronização' };

async function revoke(form: FormData) {
  'use server';
  const { sb } = await currentEstablishment();
  await sb.rpc('rupbar_owner_revoke_device', { p_device_id: String(form.get('id') ?? '') });
  revalidatePath('/sincronizacao');
}

const HOW = [
  { icon: Repeat2, text: 'Cada envio carrega identificador e versão: reenvios não duplicam dados.' },
  { icon: Timer, text: 'Dados ficam marcados como desatualizados quando o PC passa mais de 15 minutos sem sincronizar (internet do bar instável ou PC desligado).' },
  { icon: Workflow, text: 'Ações feitas aqui (perdas) entram em uma fila e só alteram o estoque depois que o PC confirmar.' },
  { icon: Lock, text: 'CPF, telefone de clientes, senhas e comprovantes não saem do PC do bar.' },
  { icon: ShieldOff, text: 'Revogar o acesso desconecta o PC imediatamente; para reconectar, use Configurações → Sincronização no RupBar do bar.' },
];

export default async function SyncPage() {
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const [{ data: devices }, { count }] = await Promise.all([
    sb.from('devices').select('*').eq('establishment_id', est.id).order('created_at', { ascending: false }),
    sb.from('sync_records').select('id', { count: 'exact', head: true }).eq('establishment_id', est.id),
  ]);
  const active = (devices ?? []).filter((d) => !d.revoked_at);
  const latest = active[0];
  const pending = active.reduce((a, d) => a + Number(d.pending_count ?? 0), 0);

  return (
    <div className="stack-l">
      <PageHeader title="Sincronização" eyebrow="Nuvem" icon={Cloud} subtitle="O PC do bar é a autoridade: funciona sem internet e envia os dados quando a conexão volta." />

      <div className="grid-3 stagger">
        <Stat label="Registros recebidos" value={(count ?? 0).toLocaleString('pt-BR')} hint="enviados pelo PC do bar até agora" icon={Database} tone="violet" />
        <Stat
          label="Última sincronização"
          value={latest?.last_sync_at ? ago(latest.last_sync_at as string) : 'nunca'}
          hint={fmtFull(latest?.last_sync_at as string | null)}
          icon={Cloud}
          tone={latest && !isStale(latest.last_sync_at as string | null) ? 'teal' : 'amber'}
        />
        <Stat label="Pendências no PC" value={pending.toLocaleString('pt-BR')} hint={pending ? 'aguardando envio para a nuvem' : 'nada aguardando envio'} icon={Repeat2} tone={pending ? 'amber' : 'green'} />
      </div>

      <Card title="PC do bar" subtitle="Computadores conectados a este estabelecimento" icon={Monitor} flush className="reveal" style={stagger(3)}>
        {!devices?.length ? (
          <Empty title="Nenhum PC conectado ainda" icon={CloudOff}>
            No RupBar do bar, abra Configurações → Sincronização e conecte com o e-mail desta conta.
          </Empty>
        ) : (
          <ul className="list">
            {devices.map((d) => {
              const stale = isStale(d.last_sync_at as string | null);
              const revoked = !!d.revoked_at;
              return (
                <li key={d.id as string} className={`list-item device ${revoked ? 'revoked' : ''}`}>
                  <span className={`device-icon ${revoked ? 'off' : stale ? 'stale' : 'live'}`} aria-hidden="true">
                    <Monitor size={20} />
                  </span>
                  <div className="grow">
                    <div className="strong">
                      {d.name as string} {d.app_version ? <span className="tiny muted">v{d.app_version as string}</span> : null}
                    </div>
                    <div className="small muted">
                      Última sincronização: {fmtFull(d.last_sync_at as string | null)} · pendências no PC: {d.pending_count as number}
                    </div>
                  </div>
                  {revoked ? (
                    <Badge color="gray">Revogado</Badge>
                  ) : stale ? (
                    <Badge color="orange" dot>
                      Desatualizado
                    </Badge>
                  ) : (
                    <Badge color="green" dot pulse>
                      Sincronizado
                    </Badge>
                  )}
                  {!revoked && (
                    <form action={revoke}>
                      <input type="hidden" name="id" value={d.id as string} />
                      <button className="btn danger small" type="submit">
                        <ShieldOff size={14} aria-hidden="true" /> Revogar acesso
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Como funciona" subtitle={`${(count ?? 0).toLocaleString('pt-BR')} registros recebidos do PC.`} icon={Workflow} tone="teal" className="reveal" style={stagger(4)}>
        <ul className="how-list">
          {HOW.map(({ icon: Icon, text }) => (
            <li key={text}>
              <span className="icon-chip teal sm" aria-hidden="true">
                <Icon size={14} />
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
