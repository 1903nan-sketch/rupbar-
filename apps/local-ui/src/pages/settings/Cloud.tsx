import { RUPBAR_CLOUD, SYNC_STATUS, type SyncStatus } from '@rupbar/core';
import { Cloud, CloudOff, MessageCircle, RefreshCw, Send } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Confirm, Field, Input, Loading, PageHeader, Select, useToast } from '../../components/ui';
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

interface WaConfig {
  provider: 'disabled' | 'meta' | 'twilio' | 'webhook';
  ownerPhone: string | null;
  meta: { phoneNumberId: string; templateName: string; templateLanguage: string; hasAccessToken: boolean };
  twilio: { accountSid: string; from: string; hasAuthToken: boolean };
  webhook: { url: string; hasToken: boolean };
}

export function NotificationSettings() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<WaConfig>('/api/notifications/whatsapp'));
  const queue = useLoad(() => api.get<{ id: string; kind: string; status: string; attempts: number; last_error: string | null; created_at: string; sent_at: string | null }[]>('/api/notifications'));
  const [f, setF] = useState<null | { provider: WaConfig['provider']; ownerPhone: string; phoneNumberId: string; accessToken: string; templateName: string; templateLanguage: string; accountSid: string; authToken: string; from: string; url: string; token: string }>(null);
  if (data && !f) setF({ provider: data.provider, ownerPhone: data.ownerPhone ?? '', phoneNumberId: data.meta.phoneNumberId, accessToken: '', templateName: data.meta.templateName, templateLanguage: data.meta.templateLanguage, accountSid: data.twilio.accountSid, authToken: '', from: data.twilio.from, url: data.webhook.url, token: '' });
  if (!data || !f) return <Loading />;

  const save = async () => {
    try {
      await api.put('/api/notifications/whatsapp', {
        provider: f.provider, ownerPhone: f.ownerPhone || null,
        meta: { phoneNumberId: f.phoneNumberId, accessToken: f.accessToken || undefined, templateName: f.templateName, templateLanguage: f.templateLanguage },
        twilio: { accountSid: f.accountSid, authToken: f.authToken || undefined, from: f.from },
        webhook: f.url ? { url: f.url, token: f.token || undefined } : undefined,
      });
      toast.success('Notificações salvas');
      setF(null);
      void reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="stack-l">
      <PageHeader title="Notificações" subtitle="Alertas de estoque mínimo no WhatsApp do proprietário. O sistema funciona normalmente sem esta integração." actions={<><Button icon={<Send size={16} />} onClick={async () => { try { await api.post('/api/notifications/whatsapp/test'); toast.success('Mensagem de teste enviada'); } catch (e) { toast.error(e); } }}>Enviar teste</Button><Button variant="primary" onClick={save}>Salvar</Button></>} />
      <Card title={<span className="row"><MessageCircle size={18} /> WhatsApp</span>}>
        <div className="stack">
          <div className="grid-2">
            <Field label="Provedor">
              <Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as WaConfig['provider'] })}>
                <option value="disabled">Desativado</option>
                <option value="meta">WhatsApp Cloud API (Meta)</option>
                <option value="twilio">Twilio</option>
                <option value="webhook">Outro provedor (webhook: Z-API, Evolution, n8n…)</option>
              </Select>
            </Field>
            <Field label="WhatsApp do proprietário"><Input value={f.ownerPhone} onChange={(e) => setF({ ...f, ownerPhone: e.target.value })} placeholder="(11) 99999-9999" /></Field>
          </div>
          {f.provider === 'meta' && (
            <div className="grid-2">
              <Field label="Phone number ID"><Input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} /></Field>
              <Field label="Access token" hint={data.meta.hasAccessToken ? 'Já configurado — deixe em branco para manter.' : undefined}><Input type="password" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} /></Field>
              <Field label="Modelo de mensagem aprovado" hint="A Meta exige modelo para mensagens iniciadas pela empresa. O texto do alerta vai no parâmetro {{1}}."><Input value={f.templateName} onChange={(e) => setF({ ...f, templateName: e.target.value })} /></Field>
              <Field label="Idioma do modelo"><Input value={f.templateLanguage} onChange={(e) => setF({ ...f, templateLanguage: e.target.value })} /></Field>
            </div>
          )}
          {f.provider === 'twilio' && (
            <div className="grid-3">
              <Field label="Account SID"><Input value={f.accountSid} onChange={(e) => setF({ ...f, accountSid: e.target.value })} /></Field>
              <Field label="Auth token" hint={data.twilio.hasAuthToken ? 'Já configurado.' : undefined}><Input type="password" value={f.authToken} onChange={(e) => setF({ ...f, authToken: e.target.value })} /></Field>
              <Field label="Número remetente"><Input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="+5511…" /></Field>
            </div>
          )}
          {f.provider === 'webhook' && (
            <div className="grid-2">
              <Field label="URL" hint="Recebe POST JSON { to, text }."><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
              <Field label="Token (Bearer)" hint={data.webhook.hasToken ? 'Já configurado.' : undefined}><Input type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></Field>
            </div>
          )}
          <p className="tiny muted">Credenciais ficam cifradas no PC (AES-256-GCM). Sem internet, os avisos aguardam na fila e são enviados quando a conexão voltar — desde que o estoque ainda esteja baixo. Um aviso por produto até ele ser reposto.</p>
        </div>
      </Card>
      <Card title="Fila de avisos" flush>
        <div className="list">
          {queue.data?.length === 0 && <div className="list-item muted">Nenhum aviso.</div>}
          {queue.data?.map((n) => (
            <div key={n.id} className="list-item">
              <div className="grow"><div>Estoque baixo</div><div className="tiny muted">{fmtDateTime(n.created_at)}{n.last_error && ` · ${n.last_error}`}</div></div>
              <Badge color={n.status === 'sent' ? 'green' : n.status === 'pending' ? 'orange' : n.status === 'failed' ? 'red' : undefined}>{{ sent: 'Enviado', pending: 'Na fila', failed: 'Falhou', discarded: 'Descartado' }[n.status] ?? n.status}</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
