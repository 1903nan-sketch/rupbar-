import QRCode from 'qrcode';
import { AlertTriangle, CheckCircle2, Copy, Router, Smartphone, Trash2, Tv, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Input, Loading, PageHeader, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useInterval, useLoad } from '../../lib/hooks';
import { useRealtime } from '../../lib/realtime';

interface NetworkInfo {
  port: number;
  ip: string | null;
  url: string;
  mdnsUrl: string;
  mdnsActive: boolean;
  addresses: { ip: string; iface: string; mac: string }[];
  previousIp: string | null;
  changedAt: string | null;
  connectedClients: number;
}

export function useQr(text: string | null) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    // QR gerado localmente (sem serviço externo). Contém apenas o endereço.
    QRCode.toDataURL(text, { margin: 1, width: 480, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => setSrc(null));
  }, [text]);
  return src;
}

export function DevicesSettings() {
  const [params] = useSearchParams();
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api.get<NetworkInfo>('/api/network'));
  useInterval(() => void reload(), 10_000);
  useRealtime('network.changed', () => void reload());
  const qr = useQr(data?.url ?? null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const primary = data.addresses[0];

  return (
    <div className="stack-l">
      <PageHeader title="Conectar dispositivo" subtitle="Celulares e tablets da equipe acessam o RupBar pela rede Wi-Fi do bar, mesmo sem internet." />
      {params.get('bemvindo') && <div className="banner success"><CheckCircle2 size={18} /> Configuração concluída! Conecte agora os celulares da equipe.</div>}
      {!data.ip && (
        <div className="banner danger">
          <AlertTriangle size={18} />
          <div>Nenhuma rede local detectada neste computador. Conecte o PC ao roteador do bar (cabo ou Wi-Fi) para que celulares e TV possam acessá-lo.</div>
        </div>
      )}
      {data.changedAt && data.previousIp && (
        <div className="banner warning">
          <AlertTriangle size={18} />
          <div>
            <strong>O endereço do PC mudou</strong> de {data.previousIp} para {data.ip} ({fmtDateTime(data.changedAt)}). Peça à equipe para escanear o QR Code novamente.
            Para evitar isso, configure a <strong>reserva de IP (DHCP)</strong> no roteador para o endereço MAC <span className="mono">{primary?.mac}</span>.
          </div>
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="qr">{qr ? <img src={qr} alt={`QR Code para ${data.url}`} /> : <div style={{ width: 240, height: 240 }} />}</div>
        <div className="stack">
          <Card>
            <div className="stack">
              <div className="row"><span className="dot green" /> <strong>Servidor ativo</strong> <Badge color="green">{data.connectedClients} dispositivo(s) conectado(s)</Badge></div>
              <div>
                <div className="label">Endereço local</div>
                <div className="row"><span className="mono strong" style={{ fontSize: 22 }}>{data.url}</span><Button size="small" variant="plain" icon={<Copy size={14} />} onClick={() => navigator.clipboard?.writeText(data.url).then(() => toast.success('Copiado'))} /></div>
                <div className="small muted">Alternativo: <span className="mono">{data.mdnsUrl}</span>{!data.mdnsActive && ' (indisponível nesta rede)'}</div>
              </div>
            </div>
          </Card>
          <Card title="Como conectar">
            <ol className="col" style={{ paddingLeft: 18, margin: 0, gap: 8 }}>
              <li><Wifi size={14} /> Conecte o celular ou tablet ao <strong>Wi-Fi do bar</strong>.</li>
              <li><Smartphone size={14} /> Abra a câmera e escaneie o QR Code.</li>
              <li>Abra o link do RupBar e entre com <strong>seu e-mail e senha</strong>.</li>
              <li>Dica: use “Adicionar à tela inicial” para abrir como aplicativo.</li>
            </ol>
            <p className="tiny muted" style={{ marginTop: 10 }}>O QR Code contém somente o endereço local — nunca senhas. Cada funcionário entra com a própria conta.</p>
          </Card>
          <Card title={<span className="row"><Router size={18} /> Endereço estável</span>}>
            <p className="small muted">
              Se o roteador reiniciar, o PC pode receber outro endereço. No painel do roteador, procure “Reserva de DHCP / IP fixo”
              {primary ? <> e reserve o IP <span className="mono">{primary.ip}</span> para o MAC <span className="mono">{primary.mac}</span> ({primary.iface})</> : null}.
              O RupBar avisa automaticamente quando o endereço mudar, e os celulares tentam reencontrar o PC sozinhos.
            </p>
            {data.addresses.length > 1 && <div className="tiny muted" style={{ marginTop: 6 }}>Outras interfaces: {data.addresses.slice(1).map((a) => `${a.ip} (${a.iface})`).join(', ')}</div>}
          </Card>
        </div>
      </div>
    </div>
  );
}

export function TvSettings() {
  const toast = useToast();
  const net = useLoad(() => api.get<NetworkInfo>('/api/network'));
  const { data, reload } = useLoad(() => api.get<{ id: string; name: string; created_at: string; last_seen_at: string | null; last_ip: string | null; revoked_at: string | null; approved_by_name: string }[]>('/api/tv/devices'));
  const [code, setCode] = useState('');
  const [name, setName] = useState('TV do balcão');
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState<string | null>(null);
  const tvUrl = net.data ? `${net.data.url}/tv` : null;
  const qr = useQr(tvUrl);

  return (
    <div className="stack-l">
      <PageHeader title="Conectar TV" subtitle="A TV mostra os pedidos em preparo e prontos, e chama os clientes por voz. Funciona sem internet." />
      <div className="grid-2">
        <Card title="1. Abra o endereço na TV">
          <div className="row top" style={{ gap: 16 }}>
            <div className="qr" style={{ padding: 8 }}>{qr ? <img src={qr} alt="" style={{ width: 140, height: 140 }} /> : null}</div>
            <div className="stack">
              <div className="mono strong" style={{ fontSize: 20 }}>{tvUrl ?? '…'}</div>
              <p className="small muted">No navegador da Smart TV (ou de um TV box / Chromecast com navegador), digite este endereço. A TV mostrará um código de 6 dígitos.</p>
            </div>
          </div>
        </Card>
        <Card title="2. Autorize com o código exibido">
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try { await api.post('/api/tv/approve', { code, name }); toast.success('TV autorizada'); setCode(''); void reload(); } catch (err) { toast.error(err); } finally { setBusy(false); }
          }}>
            <Field label="Código da TV"><Input large inputMode="numeric" maxLength={6} className="mono" style={{ letterSpacing: '.3em', fontSize: 26, textAlign: 'center' }} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>Autorizar TV</Button>
            <p className="tiny muted">A TV autorizada acessa somente o painel de retirada: número do pedido e primeiro nome. Nunca CPF, telefone ou valores.</p>
          </form>
        </Card>
      </div>
      <Card title="TVs conectadas" flush>
        <div className="list">
          {!data?.length && <div className="list-item muted">Nenhuma TV conectada.</div>}
          {data?.map((d) => (
            <div key={d.id} className="list-item" style={{ opacity: d.revoked_at ? 0.5 : 1 }}>
              <Tv size={20} />
              <div className="grow"><div className="strong">{d.name}</div><div className="tiny muted">Autorizada por {d.approved_by_name} em {fmtDateTime(d.created_at)} · visto {d.last_seen_at ? fmtDateTime(d.last_seen_at) : 'nunca'} {d.last_ip && `· ${d.last_ip}`}</div></div>
              {d.revoked_at ? <Badge>Desconectada</Badge> : <Button size="small" variant="danger" icon={<Trash2 size={14} />} onClick={() => setRevoke(d.id)}>Desconectar</Button>}
            </div>
          ))}
        </div>
      </Card>
      {revoke && <Confirm title="Desconectar TV?" danger confirmLabel="Desconectar" message="A TV deixará de exibir o painel até ser autorizada novamente." onClose={() => setRevoke(null)} onConfirm={async () => { await api.del(`/api/tv/devices/${revoke}`); void reload(); }} />}
    </div>
  );
}
