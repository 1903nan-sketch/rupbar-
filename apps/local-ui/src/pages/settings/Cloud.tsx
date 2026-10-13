import { RUPBAR_CLOUD, SYNC_STATUS, type SyncStatus } from '@rupbar/core';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Confirm, Field, Input, Loading, PageHeader, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useLoad } from '../../lib/hooks';
import { useRealtime } from '../../lib/realtime';
import { useSession } from '../../lib/session';

interface Status {
  status: SyncStatus;
  error: string | null;
  pending: number;
  pendingCommandAcks: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  cloud: { url: string; ownerEmail: string; deviceId: string; connectedAt: string } | null;
}

const COLOR: Record<SyncStatus, 'green' | 'orange' | 'red' | 'blue' | undefined> = {
  synced: 'green', syncing: 'blue', offline: 'orange', pending: 'orange', error: 'red', disabled: undefined,
};

export function SyncSettings() {
  const toast = useToast();
  const { user } = useSession();
  const { data, reload } = useLoad(() => api.get<Status>('/api/sync/status'));
  useRealtime('sync', () => void reload());
  const [f, setF] = useState({ supabaseUrl: '', anonKey: '', email: user?.email ?? '', password: '' });
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState(false);
  if (!data) return <Loading />;

  return (
    <div className="stack-l">
      <PageHeader title="Sincronização" subtitle="O PC do bar é a autoridade: funciona offline e envia os dados à nuvem quando houver internet." />
      <Card>
        <div className="row between wrap">
          <div className="row">
            {data.status === 'disabled' ? <CloudOff size={28} className="muted" /> : <Cloud size={28} style={{ color: 'var(--accent)' }} />}
            <div>
              <div className="row"><strong style={{ fontSize: 18 }}>{SYNC_STATUS[data.status]}</strong><Badge color={COLOR[data.status]}>{data.pending} pendente(s)</Badge></div>
              <div className="small muted">Última sincronização: {data.lastSuccessAt ? fmtDateTime(data.lastSuccessAt) : 'nunca'}{data.lastAttemptAt && ` · última tentativa ${fmtDateTime(data.lastAttemptAt)}`}</div>
              {data.error && <div className="small danger-text">{data.error}</div>}
            </div>
          </div>
          {data.cloud && (
            <div className="row">
              <Button icon={<RefreshCw size={16} />} onClick={async () => { await api.post('/api/sync/run'); void reload(); }}>Sincronizar agora</Button>
              <Button variant="plain" onClick={async () => { const r = await api.post<{ queued: number }>('/api/sync/resync'); toast.success(`${r.queued} registros reenfileirados`); void reload(); }}>Reenviar tudo</Button>
              <Button variant="danger" onClick={() => setDisconnect(true)}>Desconectar</Button>
            </div>
          )}
        </div>
        {data.cloud && <div className="small muted" style={{ marginTop: 12 }}>Conectado a <span className="mono">{data.cloud.url}</span> como {data.cloud.ownerEmail} desde {fmtDateTime(data.cloud.connectedAt)}.</div>}
      </Card>
      {!data.cloud && (
        <Card title="Conectar ao painel online">
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setConnectError(null);
            try { await api.post('/api/sync/connect', f); toast.success('PC conectado à nuvem. Enviando dados…'); setF({ ...f, password: '' }); void reload(); } catch (err) { setConnectError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
          }}>
            <p className="small muted">Entre com o mesmo e-mail e senha do painel online do proprietário. A senha não fica guardada: o PC recebe uma credencial própria, que pode ser revogada pelo painel.</p>
            <div className="grid-2">
              <Field label="E-mail do proprietário"><Input type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
              <Field label="Senha do painel online"><Input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            </div>
            <details className="optional-fields">
              <summary>Avançado: usar outro projeto Supabase</summary>
              <div className="grid-2">
                <Field label="URL do projeto" hint="Em branco = nuvem do RupBar"><Input value={f.supabaseUrl} onChange={(e) => setF({ ...f, supabaseUrl: e.target.value })} placeholder={RUPBAR_CLOUD.url} /></Field>
                <Field label="Chave pública (anon)" hint="Em branco = chave do RupBar"><Input value={f.anonKey} onChange={(e) => setF({ ...f, anonKey: e.target.value })} /></Field>
              </div>
            </details>
            {connectError && <div className="banner danger" role="alert">{connectError}</div>}
            <Button type="submit" variant="primary" loading={busy} disabled={!f.email || !f.password} style={{ alignSelf: 'flex-start' }}>Conectar</Button>
          </form>
        </Card>
      )}
      <Card title="Como funciona">
        <ul className="small muted col" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
          <li>Cada alteração entra em uma fila persistente no PC e é enviada com identificador e versão — reenvios nunca duplicam registros.</li>
          <li>CPF, telefone de clientes e senhas não saem do PC.</li>
          <li>Perdas registradas no site ficam “Aguardando aplicação” até o PC confirmar; se o saldo não comportar, viram conflito para você resolver aqui.</li>
          <li>Sem internet, tudo continua funcionando; a fila é enviada quando a conexão voltar, inclusive após reiniciar o PC.</li>
        </ul>
      </Card>
      {disconnect && <Confirm title="Desconectar da nuvem?" danger confirmLabel="Desconectar" message="O painel online deixará de receber atualizações deste PC." onClose={() => setDisconnect(false)} onConfirm={async () => { await api.post('/api/sync/disconnect'); void reload(); }} />}
    </div>
  );
}
