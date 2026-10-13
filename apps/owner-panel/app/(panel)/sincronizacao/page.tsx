import { isStale } from '@rupbar/core';
import { revalidatePath } from 'next/cache';
import { Badge, Card, PageHeader } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';

export const metadata = { title: 'Sincronização' };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'nunca');

async function revoke(form: FormData) {
  'use server';
  const { sb } = await currentEstablishment();
  await sb.rpc('rupbar_owner_revoke_device', { p_device_id: String(form.get('id') ?? '') });
  revalidatePath('/sincronizacao');
}

export default async function SyncPage() {
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const [{ data: devices }, { count }] = await Promise.all([
    sb.from('devices').select('*').eq('establishment_id', est.id).order('created_at', { ascending: false }),
    sb.from('sync_records').select('id', { count: 'exact', head: true }).eq('establishment_id', est.id),
  ]);
  return (
    <div className="stack-l">
      <PageHeader title="Sincronização" subtitle="O PC do bar é a autoridade: funciona sem internet e envia os dados quando a conexão volta." />
      <Card title="PC do bar" flush>
        <div className="list">
          {!devices?.length && <div className="list-item muted">Nenhum PC conectado ainda.</div>}
          {devices?.map((d) => {
            const stale = isStale(d.last_sync_at as string | null);
            return (
              <div key={d.id as string} className="list-item" style={{ opacity: d.revoked_at ? 0.5 : 1 }}>
                <div className="grow">
                  <div className="strong">{d.name as string} {d.app_version ? <span className="tiny muted">v{d.app_version as string}</span> : null}</div>
                  <div className="small muted">Última sincronização: {fmt(d.last_sync_at as string | null)} · pendências no PC: {d.pending_count as number}</div>
                </div>
                {d.revoked_at ? <Badge>Revogado</Badge> : stale ? <Badge color="orange">Desatualizado</Badge> : <Badge color="green">Sincronizado</Badge>}
                {!d.revoked_at && (
                  <form action={revoke}><input type="hidden" name="id" value={d.id as string} /><button className="btn danger small" type="submit">Revogar acesso</button></form>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Como funciona">
        <ul className="small muted col" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
          <li>{count ?? 0} registros recebidos do PC. Cada envio carrega identificador e versão: reenvios não duplicam dados.</li>
          <li>Dados ficam marcados como desatualizados quando o PC passa mais de 15 minutos sem sincronizar (internet do bar instável ou PC desligado).</li>
          <li>Ações feitas aqui (perdas) entram em uma fila e só alteram o estoque depois que o PC confirmar.</li>
          <li>CPF, telefone de clientes, senhas e comprovantes não saem do PC do bar.</li>
          <li>Revogar o acesso desconecta o PC imediatamente; para reconectar, use Configurações → Sincronização no RupBar do bar.</li>
        </ul>
      </Card>
    </div>
  );
}
