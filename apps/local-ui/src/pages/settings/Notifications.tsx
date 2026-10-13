import {
  EVOLUTION_INSTANCE_RE, formatPhoneBR, normalizeEvolutionUrl, normalizePhoneBR, WA_CONNECTION_STATUS, type WaConnectionStatus,
} from '@rupbar/core';
import QRCode from 'qrcode';
import {
  Bell, Check, ChevronLeft, ChevronRight, CircleCheck, CirclePlus, Eye, EyeOff, Info, KeyRound, Link2, MessageCircle, Package,
  PlugZap, Power, QrCode, RefreshCw, Send, Server, ShieldCheck, Smartphone, Sparkles, Unplug, Wallet, Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Input, Loading, PageHeader, Spinner, Switch, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useInterval, useLoad } from '../../lib/hooks';
import '../../styles/notifications.css';

/*
 * Notificações por WhatsApp: assistente passo a passo.
 * Evolution API é o caminho recomendado (QR Code, sem aprovação da Meta);
 * Meta, Twilio e webhook continuam disponíveis em "Outros provedores".
 */

type Provider = 'disabled' | 'meta' | 'twilio' | 'webhook' | 'evolution';
type ActiveProvider = Exclude<Provider, 'disabled'>;
type StepKey = 'provider' | 'server' | 'connect' | 'alerts';

interface WaConfig {
  provider: Provider;
  ownerPhone: string | null;
  meta: { phoneNumberId: string; templateName: string; templateLanguage: string; hasAccessToken: boolean };
  twilio: { accountSid: string; from: string; hasAuthToken: boolean };
  webhook: { url: string; hasToken: boolean };
  evolution: { baseUrl: string; instance: string; hasApiKey: boolean };
  alerts: { stockLow: boolean; cashClosed: boolean };
}

interface Profile {
  number: string | null;
  name: string | null;
}

interface EvoState {
  state: string | null;
  status: WaConnectionStatus;
  profile?: Profile | null;
  baseUrl?: string;
  instance?: string;
}

interface EvoQrCode {
  base64: string | null;
  code: string | null;
  pairingCode: string | null;
}

interface EvoQr {
  status: WaConnectionStatus;
  qr: EvoQrCode | null;
}

interface QueueItem {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

interface Form {
  baseUrl: string;
  apiKey: string;
  instance: string;
  ownerPhone: string;
  stockLow: boolean;
  cashClosed: boolean;
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
  templateLanguage: string;
  accountSid: string;
  authToken: string;
  from: string;
  url: string;
  token: string;
}

type SetField = <K extends keyof Form>(key: K, value: Form[K]) => void;

const URL_CONFIG = '/api/notifications/whatsapp';
const URL_EVO = '/api/notifications/whatsapp/evolution';
const QR_REFRESH_S = 20;
const POLL_MS = 3_000;

const PROVIDER_LABEL: Record<Provider, string> = {
  disabled: 'Desativado',
  evolution: 'Evolution API',
  meta: 'WhatsApp Cloud API (Meta)',
  twilio: 'Twilio',
  webhook: 'Webhook',
};

const KIND_LABEL: Record<string, string> = { stock_low: 'Estoque baixo', cash_closed: 'Fechamento de caixa' };

const OTHER_PROVIDERS: { key: ActiveProvider; icon: ReactNode; title: string; text: string }[] = [
  { key: 'meta', icon: <ShieldCheck size={18} />, title: 'WhatsApp Cloud API (Meta)', text: 'Oficial da Meta. Exige conta comercial verificada e modelo de mensagem aprovado.' },
  { key: 'twilio', icon: <Zap size={18} />, title: 'Twilio', text: 'Serviço pago por mensagem, com número remetente habilitado para WhatsApp.' },
  { key: 'webhook', icon: <Link2 size={18} />, title: 'Webhook (Z-API, n8n…)', text: 'Envia { to, text } por POST para qualquer serviço ou automação.' },
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "5511955554444" → "+55 (11) 95555-4444". */
const fmtWa = (digits: string | null | undefined) => (digits ? `+55 ${formatPhoneBR(digits.replace(/^55/, ''))}` : '');

/** Código de pareamento em dois blocos: "WZYE-H1YY". */
const fmtPairing = (c: string) => (c.length === 8 && !c.includes('-') ? `${c.slice(0, 4)}-${c.slice(4)}` : c);

function initialForm(c: WaConfig): Form {
  return {
    baseUrl: c.evolution.baseUrl,
    apiKey: '',
    instance: c.evolution.instance || 'rupbar',
    ownerPhone: c.ownerPhone ? formatPhoneBR(c.ownerPhone) : '',
    stockLow: c.alerts.stockLow,
    cashClosed: c.alerts.cashClosed,
    phoneNumberId: c.meta.phoneNumberId,
    accessToken: '',
    templateName: c.meta.templateName,
    templateLanguage: c.meta.templateLanguage,
    accountSid: c.twilio.accountSid,
    authToken: '',
    from: c.twilio.from,
    url: c.webhook.url,
    token: '',
  };
}

/** Corpo do PUT: só a seção do provedor escolhido (as demais ficam como estão no PC). */
function buildPayload(provider: ActiveProvider, f: Form) {
  return {
    provider,
    ownerPhone: f.ownerPhone || null,
    alerts: { stockLow: f.stockLow, cashClosed: f.cashClosed },
    ...(provider === 'evolution' ? { evolution: { baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, instance: f.instance } } : {}),
    ...(provider === 'meta'
      ? { meta: { phoneNumberId: f.phoneNumberId, accessToken: f.accessToken || undefined, templateName: f.templateName, templateLanguage: f.templateLanguage } }
      : {}),
    ...(provider === 'twilio' ? { twilio: { accountSid: f.accountSid, authToken: f.authToken || undefined, from: f.from } } : {}),
    ...(provider === 'webhook' && f.url ? { webhook: { url: f.url, token: f.token || undefined } } : {}),
  };
}

// ---------------------------------------------------------------- página

export function NotificationSettings() {
  const { data, error, reload } = useLoad(() => api.get<WaConfig>(URL_CONFIG));
  const queue = useLoad(() => api.get<QueueItem[]>('/api/notifications'));
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack-l">
      <PageHeader
        title="Notificações"
        subtitle="Receba no seu WhatsApp os alertas do bar — estoque baixo e fechamento de caixa. O sistema funciona normalmente sem esta integração."
      />
      <WhatsAppWizard config={data} onChanged={() => { void reload(); void queue.reload(); }} />
      <QueueCard items={queue.data} onReload={() => void queue.reload()} />
    </div>
  );
}

// ---------------------------------------------------------------- assistente

function WhatsAppWizard({ config, onChanged }: { config: WaConfig; onChanged: () => void }) {
  const toast = useToast();
  const active = config.provider !== 'disabled';
  const [provider, setProvider] = useState<ActiveProvider>(active ? (config.provider as ActiveProvider) : 'evolution');
  const steps: StepKey[] = provider === 'evolution' ? ['provider', 'server', 'connect', 'alerts'] : ['provider', 'server', 'alerts'];
  const [step, setStep] = useState<StepKey>(active ? 'alerts' : 'provider');
  const [visited, setVisited] = useState<Set<StepKey>>(() => new Set(active ? steps : ['provider']));
  const [f, setF] = useState<Form>(() => initialForm(config));
  const [conn, setConn] = useState<EvoState | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [firstQr, setFirstQr] = useState<EvoQrCode | null>(null);
  const [disable, setDisable] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const set: SetField = (key, value) => setF((x) => ({ ...x, [key]: value }));

  const go = (s: StepKey) => {
    setStep(s);
    setVisited((v) => new Set(v).add(s));
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // Dados da Evolution já salvos: consulta o estado uma vez ao abrir a tela.
  const evo = config.evolution;
  const hasSavedEvolution = !!(evo.baseUrl && evo.instance && evo.hasApiKey);
  useEffect(() => {
    if (!hasSavedEvolution) return;
    api.get<EvoState>(`${URL_EVO}/state`).then((r) => { setConn(r); setConnErr(null); }).catch((e) => setConnErr(errMsg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const labels: Record<StepKey, string> = { provider: 'Provedor', server: provider === 'evolution' ? 'Servidor' : 'Credenciais', connect: 'Conectar', alerts: 'Alertas' };

  return (
    <>
      <Summary
        config={config}
        conn={conn}
        connErr={connErr}
        onDisable={() => setDisable(true)}
        onReconnect={() => { setProvider('evolution'); go('connect'); }}
      />
      <div ref={top} />
      <Card>
        <Stepper steps={steps} current={step} visited={visited} labels={labels} onGo={go} />
        <div key={step + provider} className="wa-panel stack" style={{ marginTop: 22 }}>
          {step === 'provider' && <ProviderStep provider={provider} onChoose={(p) => { setProvider(p); go('server'); }} />}
          {step === 'server' && provider === 'evolution' && (
            <EvolutionServerStep
              f={f} set={set} config={config} conn={conn}
              onConn={(r) => { setConn(r); setConnErr(null); }}
              onSaved={onChanged}
              onBack={() => go('provider')}
              onNext={(qr) => { setFirstQr(qr); go(conn?.status === 'connected' && !qr ? 'alerts' : 'connect'); }}
              onConnected={() => go('alerts')}
            />
          )}
          {step === 'server' && provider !== 'evolution' && (
            <OtherProviderStep provider={provider} f={f} set={set} config={config} onBack={() => go('provider')} onNext={() => go('alerts')} />
          )}
          {step === 'connect' && (
            <ConnectStep
              initialQr={firstQr}
              conn={conn}
              onConn={(r) => { setConn(r); setConnErr(null); }}
              onBack={() => go('server')}
              onDone={() => go('alerts')}
            />
          )}
          {step === 'alerts' && (
            <AlertsStep
              provider={provider} f={f} set={set} config={config}
              onBack={() => go(provider === 'evolution' ? (conn?.status === 'connected' ? 'connect' : 'server') : 'server')}
              onSaved={onChanged}
            />
          )}
        </div>
      </Card>
      {disable && (
        <Confirm
          title="Desativar alertas no WhatsApp?"
          confirmLabel="Desativar"
          danger
          message="Os avisos deixam de ser enviados. As configurações ficam guardadas para você reativar quando quiser."
          onClose={() => setDisable(false)}
          onConfirm={async () => {
            await api.put(URL_CONFIG, { provider: 'disabled', ownerPhone: config.ownerPhone });
            toast.success('Alertas no WhatsApp desativados');
            onChanged();
          }}
        />
      )}
    </>
  );
}

function Summary({ config, conn, connErr, onDisable, onReconnect }: {
  config: WaConfig; conn: EvoState | null; connErr: string | null; onDisable: () => void; onReconnect: () => void;
}) {
  const active = config.provider !== 'disabled';
  const isEvo = config.provider === 'evolution';
  const alerts = [config.alerts.stockLow && 'estoque baixo', config.alerts.cashClosed && 'fechamento de caixa'].filter(Boolean).join(' e ');
  return (
    <Card>
      <div className="wa-hero">
        <div className={`wa-hero-icon ${active ? '' : 'off'}`}><MessageCircle size={28} /></div>
        <div className="grow">
          <h2>{active ? 'Alertas no WhatsApp ativos' : 'Alertas no WhatsApp desativados'}</h2>
          <div className="small muted">
            {active
              ? <>Via {PROVIDER_LABEL[config.provider]} · enviando para <strong>{config.ownerPhone ? formatPhoneBR(config.ownerPhone) : '—'}</strong>{alerts && <> · {alerts}</>}</>
              : 'Siga os passos abaixo para ativar. Leva uns 2 minutos.'}
          </div>
        </div>
        {active && isEvo && conn && <StatusPill status={conn.status} />}
        {active && <Button variant="danger" icon={<Power size={16} />} onClick={onDisable}>Desativar</Button>}
      </div>
      {active && isEvo && conn && conn.status !== 'connected' && (
        <div className="banner warning" style={{ marginTop: 14, alignItems: 'center' }}>
          <Unplug size={18} style={{ flex: 'none' }} />
          <div className="grow small">O WhatsApp não está conectado na Evolution. Os alertas ficam guardados na fila até você reconectar.</div>
          <Button size="small" variant="primary" onClick={onReconnect}>Reconectar</Button>
        </div>
      )}
      {active && isEvo && connErr && (
        <div className="banner danger small" style={{ marginTop: 14 }}>Não foi possível verificar a Evolution agora: {connErr}</div>
      )}
    </Card>
  );
}

function Stepper({ steps, current, visited, labels, onGo }: {
  steps: StepKey[]; current: StepKey; visited: Set<StepKey>; labels: Record<StepKey, string>; onGo: (s: StepKey) => void;
}) {
  const ci = steps.indexOf(current);
  return (
    <nav className="wa-steps" aria-label="Etapas da configuração">
      {steps.map((s, i) => {
        const done = i < ci;
        return (
          <button
            key={s}
            type="button"
            className={`wa-step ${s === current ? 'active' : ''} ${done ? 'done' : ''}`}
            disabled={!visited.has(s) && i > ci}
            aria-current={s === current ? 'step' : undefined}
            onClick={() => onGo(s)}
          >
            <span className="n">{done ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
            <span className="label">{labels[s]}</span>
          </button>
        );
      })}
    </nav>
  );
}

function StepTitle({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div>
      <div className="wa-step-title">{icon}<h3>{title}</h3></div>
      {children && <p className="small muted">{children}</p>}
    </div>
  );
}

function Help({ icon = <Info size={16} />, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className="wa-help">{icon}<span>{children}</span></div>;
}

export function StatusPill({ status }: { status: WaConnectionStatus }) {
  return (
    <span className={`wa-pill ${status}`} role="status">
      <span className="dot" />
      {WA_CONNECTION_STATUS[status]}
    </span>
  );
}

// ---------------------------------------------------------------- 1. provedor

function ProviderStep({ provider, onChoose }: { provider: ActiveProvider; onChoose: (p: ActiveProvider) => void }) {
  return (
    <>
      <StepTitle icon={<Sparkles size={20} />} title="Como o RupBar vai enviar as mensagens?">
        Escolha o serviço que entrega os alertas no WhatsApp. Se não souber qual usar, fique com o recomendado.
      </StepTitle>
      <button type="button" className={`wa-option recommended ${provider === 'evolution' ? 'active' : ''}`} onClick={() => onChoose('evolution')}>
        <span className="wa-option-icon"><QrCode size={22} /></span>
        <span className="grow">
          <span className="row wrap"><strong style={{ fontSize: 16 }}>Evolution API</strong><Badge color="green">Recomendado</Badge></span>
          <span className="small muted" style={{ display: 'block', marginTop: 6, lineHeight: 1.55 }}>
            A Evolution é um programa gratuito que liga um WhatsApp comum ao RupBar — funciona como o WhatsApp Web: você lê um
            QR Code com o celular uma única vez e pronto. Não precisa de aprovação da Meta nem paga por mensagem.
          </span>
          <span className="wa-perks">
            <span><Check size={14} strokeWidth={3} />Sem custo por mensagem</span>
            <span><Check size={14} strokeWidth={3} />Conecta em 2 minutos</span>
            <span><Check size={14} strokeWidth={3} />Usa um número de WhatsApp comum</span>
          </span>
        </span>
        <ChevronRight size={20} className="muted" style={{ alignSelf: 'center', flex: 'none' }} />
      </button>
      <Help>
        Você vai precisar de um <strong>servidor com a Evolution instalada</strong>: o endereço dele e a chave da API. Quem instalou a
        Evolution para você (técnico, agência ou empresa de hospedagem) passa esses dois dados.
      </Help>
      <details className="optional-fields" open={provider !== 'evolution'}>
        <summary>Outros provedores</summary>
        <div className="wa-option-list">
          {OTHER_PROVIDERS.map((o) => (
            <button key={o.key} type="button" className={`wa-option ${provider === o.key ? 'active' : ''}`} onClick={() => onChoose(o.key)}>
              <span className="wa-option-icon">{o.icon}</span>
              <span className="grow">
                <strong style={{ display: 'block' }}>{o.title}</strong>
                <span className="small muted" style={{ lineHeight: 1.5 }}>{o.text}</span>
              </span>
            </button>
          ))}
        </div>
      </details>
    </>
  );
}

// ---------------------------------------------------------------- 2. servidor (Evolution)

function EvolutionServerStep({ f, set, config, conn, onConn, onSaved, onBack, onNext, onConnected }: {
  f: Form; set: SetField; config: WaConfig; conn: EvoState | null;
  onConn: (r: EvoState) => void; onSaved: () => void; onBack: () => void; onNext: (qr: EvoQrCode | null) => void; onConnected: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'test' | 'create' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [tested, setTested] = useState(false);

  const normalized = normalizeEvolutionUrl(f.baseUrl);
  const instanceErr = f.instance && !EVOLUTION_INSTANCE_RE.test(f.instance.trim()) ? 'Use letras, números, "-" ou "_", sem espaços (ex.: rupbar).' : null;
  const sameServer = !!config.evolution.baseUrl && normalized === config.evolution.baseUrl;
  const keyReady = !!f.apiKey || (config.evolution.hasApiKey && sameServer);
  const canTest = !!normalized && !!f.instance.trim() && !instanceErr && keyReady;
  const creds = () => ({ baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, instance: f.instance.trim() });

  const test = async () => {
    setBusy('test');
    setErr(null);
    try {
      const r = await api.post<EvoState>(`${URL_EVO}/test`, creds());
      onConn(r);
      setTested(true);
      if (r.baseUrl) set('baseUrl', r.baseUrl);
      set('apiKey', '');
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy('create');
    setErr(null);
    try {
      const r = await api.post<EvoState & { created: boolean; qr: EvoQrCode | null }>(`${URL_EVO}/instance`, creds());
      onConn(r);
      set('apiKey', '');
      onSaved();
      toast.success(r.created ? 'Instância criada! Agora conecte o WhatsApp.' : 'A instância já existia — tudo certo.');
      if (r.status === 'connected') onConnected();
      else onNext(r.qr);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const status = conn?.status;
  return (
    <>
      <StepTitle icon={<Server size={20} />} title="Dados do servidor da Evolution">
        São três informações. Quem instalou a Evolution pode te passar todas elas.
      </StepTitle>
      <div className="grid-2">
        <Field
          label="Endereço da Evolution API"
          hint={normalized && normalized !== f.baseUrl.trim() ? <>Vamos usar: <span className="mono">{normalized}</span></> : 'O link do servidor, o mesmo que você abre no navegador.'}
        >
          <Input value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://evo.seudominio.com.br" inputMode="url" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Nome da instância" error={instanceErr} hint="O “apelido” deste WhatsApp dentro da Evolution.">
          <Input value={f.instance} onChange={(e) => set('instance', e.target.value)} placeholder="rupbar" autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <Field
        label="Chave da API (apikey)"
        hint={config.evolution.hasApiKey && sameServer ? <span className="success-text">Chave já salva e cifrada neste PC — deixe em branco para manter.</span> : 'Funciona como uma senha da Evolution.'}
      >
        <div className="wa-secret">
          <Input
            aria-label="Chave da API (apikey)"
            type={showKey ? 'text' : 'password'}
            value={f.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder={config.evolution.hasApiKey && sameServer ? '••••••••••••' : 'Cole aqui a chave'}
            autoComplete="off"
            spellCheck={false}
          />
          <Button variant="plain" icon={showKey ? <EyeOff size={16} /> : <Eye size={16} />} aria-label={showKey ? 'Ocultar chave' : 'Mostrar chave'} onClick={() => setShowKey(!showKey)} />
        </div>
      </Field>
      <Help icon={<KeyRound size={16} />}>
        <strong>Endereço:</strong> pode colar o link do painel (terminado em <span className="mono">/manager</span>) que o RupBar ajusta.{' '}
        <strong>Chave:</strong> no servidor ela se chama <span className="mono">AUTHENTICATION_API_KEY</span>; fica guardada cifrada neste PC e
        nunca mais aparece na tela. <strong>Instância:</strong> use um nome simples, como <span className="mono">rupbar</span> — se ainda não
        existir, o RupBar cria para você.
      </Help>

      <div className="wa-actions">
        <Button variant="primary" icon={<PlugZap size={16} />} loading={busy === 'test'} disabled={!canTest || busy !== null} onClick={test}>
          Testar conexão
        </Button>
        {status && <StatusPill status={status} />}
        {status === 'connected' && conn?.profile?.number && <span className="small muted">{fmtWa(conn.profile.number)}{conn.profile.name && ` · ${conn.profile.name}`}</span>}
      </div>

      {err && <ErrorBox error={err} />}
      {!err && status === 'not_found' && (
        <div className="banner" style={{ alignItems: 'center' }}>
          <CirclePlus size={20} style={{ color: 'var(--accent)', flex: 'none' }} />
          <div className="grow">
            <strong>A Evolution respondeu, mas a instância “{f.instance.trim()}” ainda não existe.</strong>
            <div className="small muted">É só criar — leva um segundo. Em seguida aparece o QR Code.</div>
          </div>
          <Button variant="primary" loading={busy === 'create'} disabled={busy !== null || !canTest} onClick={create}>Criar instância</Button>
        </div>
      )}
      {!err && status === 'connected' && (
        <div className="banner success">
          <CircleCheck size={20} style={{ color: 'var(--green)', flex: 'none' }} />
          <div className="grow"><strong>Tudo certo! Este WhatsApp já está conectado.</strong><div className="small muted">Pode seguir direto para os alertas.</div></div>
        </div>
      )}
      {!err && (status === 'waiting_qr' || status === 'disconnected') && tested && (
        <div className="banner success">
          <CircleCheck size={20} style={{ color: 'var(--green)', flex: 'none' }} />
          <div className="grow"><strong>Conexão com a Evolution OK! Dados salvos.</strong><div className="small muted">Falta só conectar o celular lendo o QR Code.</div></div>
        </div>
      )}

      <div className="wa-actions">
        <Button variant="plain" icon={<ChevronLeft size={16} />} onClick={onBack}>Voltar</Button>
        <span className="spacer" />
        {status === 'connected' ? (
          <Button variant="primary" onClick={onConnected}>Continuar <ChevronRight size={16} /></Button>
        ) : (
          <Button variant="primary" disabled={!status || status === 'not_found'} onClick={() => onNext(null)}>
            Conectar WhatsApp <ChevronRight size={16} />
          </Button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 2. credenciais (outros provedores)

function OtherProviderStep({ provider, f, set, config, onBack, onNext }: {
  provider: ActiveProvider; f: Form; set: SetField; config: WaConfig; onBack: () => void; onNext: () => void;
}) {
  const kept = 'Já configurado — deixe em branco para manter.';
  return (
    <>
      <StepTitle icon={<KeyRound size={20} />} title={`Credenciais: ${PROVIDER_LABEL[provider]}`}>
        Dados fornecidos pelo painel do provedor. Segredos ficam cifrados neste PC e nunca voltam para a tela.
      </StepTitle>
      {provider === 'meta' && (
        <>
          <div className="grid-2">
            <Field label="Phone number ID" hint="Em WhatsApp → Configuração da API, no painel de desenvolvedores da Meta."><Input value={f.phoneNumberId} onChange={(e) => set('phoneNumberId', e.target.value)} /></Field>
            <Field label="Access token" hint={config.meta.hasAccessToken ? kept : 'Token permanente de um usuário do sistema.'}><Input type="password" value={f.accessToken} onChange={(e) => set('accessToken', e.target.value)} autoComplete="off" /></Field>
            <Field label="Modelo de mensagem aprovado" hint="A Meta exige modelo para mensagens iniciadas pela empresa. O texto do alerta vai no parâmetro {{1}}."><Input value={f.templateName} onChange={(e) => set('templateName', e.target.value)} /></Field>
            <Field label="Idioma do modelo" hint="Normalmente pt_BR."><Input value={f.templateLanguage} onChange={(e) => set('templateLanguage', e.target.value)} /></Field>
          </div>
        </>
      )}
      {provider === 'twilio' && (
        <div className="grid-3">
          <Field label="Account SID" hint="Na página inicial do console da Twilio."><Input value={f.accountSid} onChange={(e) => set('accountSid', e.target.value)} /></Field>
          <Field label="Auth token" hint={config.twilio.hasAuthToken ? kept : 'Ao lado do Account SID.'}><Input type="password" value={f.authToken} onChange={(e) => set('authToken', e.target.value)} autoComplete="off" /></Field>
          <Field label="Número remetente" hint="Número habilitado para WhatsApp na Twilio."><Input value={f.from} onChange={(e) => set('from', e.target.value)} placeholder="+5511…" /></Field>
        </div>
      )}
      {provider === 'webhook' && (
        <div className="grid-2">
          <Field label="URL" hint="Recebe POST JSON { to, text, source }."><Input value={f.url} onChange={(e) => set('url', e.target.value)} inputMode="url" spellCheck={false} /></Field>
          <Field label="Token (Bearer)" hint={config.webhook.hasToken ? kept : 'Opcional: enviado no cabeçalho Authorization.'}><Input type="password" value={f.token} onChange={(e) => set('token', e.target.value)} autoComplete="off" /></Field>
        </div>
      )}
      <div className="wa-actions">
        <Button variant="plain" icon={<ChevronLeft size={16} />} onClick={onBack}>Voltar</Button>
        <span className="spacer" />
        <Button variant="primary" onClick={onNext}>Continuar <ChevronRight size={16} /></Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 3. conectar (QR Code)

/** Imagem do QR: a enviada pela Evolution ou, se vier só o texto, desenhada aqui (sem serviço externo). */
function useQrImage(qr: EvoQrCode | null): string | null {
  const [generated, setGenerated] = useState<string | null>(null);
  const code = qr && !qr.base64 ? qr.code : null;
  useEffect(() => {
    if (!code) {
      setGenerated(null);
      return;
    }
    let alive = true;
    QRCode.toDataURL(code, { margin: 1, width: 480, errorCorrectionLevel: 'L' })
      .then((src) => { if (alive) setGenerated(src); })
      .catch(() => { if (alive) setGenerated(null); });
    return () => { alive = false; };
  }, [code]);
  return qr?.base64 ?? generated;
}

function Ring({ value }: { value: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg className="wa-ring" viewBox="0 0 22 22" aria-hidden="true">
      <circle className="track" cx="11" cy="11" r={r} />
      <circle className="bar" cx="11" cy="11" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))} />
    </svg>
  );
}

function ConnectStep({ initialQr, conn, onConn, onBack, onDone }: {
  initialQr: EvoQrCode | null; conn: EvoState | null; onConn: (r: EvoState) => void; onBack: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [qr, setQr] = useState<EvoQrCode | null>(initialQr);
  const [qrAt, setQrAt] = useState(() => (initialQr ? Date.now() : 0));
  const [loadingQr, setLoadingQr] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [logout, setLogout] = useState(false);
  const polling = useRef(false);
  const connected = conn?.status === 'connected';
  const src = useQrImage(qr);

  const fetchQr = useCallback(async () => {
    setLoadingQr(true);
    try {
      const r = await api.get<EvoQr>(`${URL_EVO}/qr`);
      if (r.status === 'connected') {
        onConn(await api.get<EvoState>(`${URL_EVO}/state`));
        return;
      }
      setQr(r.qr);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      // Também em caso de erro: nova tentativa só no próximo ciclo.
      setQrAt(Date.now());
      setLoadingQr(false);
    }
  }, [onConn]);

  useEffect(() => {
    if (!initialQr && !connected) void fetchQr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relógio de 1 s: contagem regressiva e troca do QR a cada ~20 s.
  useInterval(() => {
    const t = Date.now();
    setNow(t);
    if (!loadingQr && qrAt && t - qrAt >= QR_REFRESH_S * 1000) void fetchQr();
  }, connected ? null : 1000);

  // Estado a cada 3 s: quando o celular lê o QR, mostra a confirmação.
  useInterval(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      onConn(await api.get<EvoState>(`${URL_EVO}/state`));
    } catch {
      /* falha momentânea: tenta de novo no próximo ciclo */
    } finally {
      polling.current = false;
    }
  }, connected ? null : POLL_MS);

  const remaining = qrAt ? Math.max(0, QR_REFRESH_S - Math.floor((now - qrAt) / 1000)) : QR_REFRESH_S;

  if (connected) {
    const p = conn?.profile;
    return (
      <>
        <div className="wa-success">
          <div className="wa-check">
            <svg viewBox="0 0 104 104" aria-hidden="true"><path d="M32 54 L46 68 L74 38" /></svg>
          </div>
          <h2>WhatsApp conectado!</h2>
          <p className="muted" style={{ maxWidth: 460 }}>
            {p?.number
              ? <>Os alertas vão sair do número <strong>{fmtWa(p.number)}</strong>{p.name && <> ({p.name})</>}.</>
              : 'Tudo pronto para enviar os alertas do bar.'}
          </p>
          <Button variant="primary" size="large" onClick={onDone}>Continuar <ChevronRight size={18} /></Button>
          <Button variant="plain" size="small" icon={<Unplug size={14} />} onClick={() => setLogout(true)}>Desconectar este WhatsApp</Button>
        </div>
        {logout && (
          <Confirm
            title="Desconectar o WhatsApp?"
            danger
            confirmLabel="Desconectar"
            message="O aparelho sai de “Aparelhos conectados” e os alertas param até você ler um novo QR Code."
            onClose={() => setLogout(false)}
            onConfirm={async () => {
              const r = await api.post<EvoState>(`${URL_EVO}/logout`);
              onConn(r);
              toast.success('WhatsApp desconectado');
              void fetchQr();
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <StepTitle icon={<Smartphone size={20} />} title="Conecte o WhatsApp que vai enviar os alertas">
        Igual ao WhatsApp Web: o celular lê o código e fica conectado, mesmo com o RupBar fechado.
      </StepTitle>
      <div className="wa-connect">
        <div className="stack">
          <ol className="wa-howto">
            <li><span>Abra o <strong>WhatsApp</strong> no celular do número que vai <strong>enviar</strong> os avisos.</span></li>
            <li><span>Toque em <strong>Mais opções ⋮</strong> (Android) ou em <strong>Configurações</strong> (iPhone) e depois em <strong>Aparelhos conectados</strong>.</span></li>
            <li><span>Toque em <strong>Conectar um aparelho</strong> e aponte a câmera para o código.</span></li>
          </ol>
          <Help>
            Dica: use um número só do bar (pode ser um chip separado). Se conectar o seu próprio número, os alertas aparecem na
            conversa “Você” (mensagens para si mesmo).
          </Help>
          <div className="row wrap">
            <StatusPill status={conn?.status === 'disconnected' ? 'waiting_qr' : (conn?.status ?? 'waiting_qr')} />
            <span className="small muted">Verificando a cada 3 segundos…</span>
          </div>
          {err && <ErrorBox error={err} onRetry={() => void fetchQr()} />}
        </div>
        <div className="wa-qr-wrap">
          <div className={`wa-qr ${loadingQr && src ? 'stale' : ''}`}>
            {src ? <img key={src} src={src} alt="QR Code para conectar o WhatsApp" /> : <Spinner size={40} />}
          </div>
          <div className="wa-qr-meta">
            <Ring value={remaining / QR_REFRESH_S} />
            <span>Novo código em {remaining}s</span>
            <Button size="small" variant="plain" icon={<RefreshCw size={14} />} loading={loadingQr} onClick={() => void fetchQr()}>Gerar agora</Button>
          </div>
          {qr?.pairingCode && (
            <div className="wa-pairing">
              <span className="tiny muted">Prefere digitar? Em “Conectar com número de telefone”, use:</span>
              <span className="code">{fmtPairing(qr.pairingCode)}</span>
            </div>
          )}
        </div>
      </div>
      <div className="wa-actions">
        <Button variant="plain" icon={<ChevronLeft size={16} />} onClick={onBack}>Voltar</Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 4. alertas

function AlertsStep({ provider, f, set, config, onBack, onSaved }: {
  provider: ActiveProvider; f: Form; set: SetField; config: WaConfig; onBack: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const phone = normalizePhoneBR(f.ownerPhone);
  const phoneErr = f.ownerPhone.trim() && !phone ? 'Telefone inválido: use DDD + número, ex.: (11) 99999-9999.' : null;
  const isCurrent = config.provider === provider;

  const save = async () => {
    setBusy('save');
    setResult(null);
    try {
      await api.put(URL_CONFIG, buildPayload(provider, f));
      set('apiKey', '');
      set('accessToken', '');
      set('authToken', '');
      set('token', '');
      toast.success(isCurrent ? 'Alterações salvas' : 'Alertas no WhatsApp ativados!');
      onSaved();
    } catch (e) {
      setResult({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setResult(null);
    try {
      if (provider === 'evolution') {
        // Teste direto pela Evolution: funciona antes mesmo de ativar.
        await api.post(`${URL_EVO}/send-test`, { phone: f.ownerPhone });
      } else {
        await api.put(URL_CONFIG, buildPayload(provider, f));
        onSaved();
        await api.post(`${URL_CONFIG}/test`);
      }
      setResult({ ok: true, text: `Mensagem de teste enviada para ${phone ? formatPhoneBR(phone) : f.ownerPhone}. Confira o WhatsApp!` });
    } catch (e) {
      setResult({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <StepTitle icon={<Bell size={20} />} title="Quem recebe e quais alertas">
        Diga para qual WhatsApp os avisos devem ir e escolha o que quer receber.
      </StepTitle>
      <Field label="Seu WhatsApp (quem recebe os alertas)" error={phoneErr} hint="Com DDD, por exemplo (11) 99999-9999. É para este número que o RupBar manda os avisos.">
        <Input large value={f.ownerPhone} onChange={(e) => set('ownerPhone', e.target.value)} placeholder="(11) 99999-9999" inputMode="tel" autoComplete="tel" style={{ maxWidth: 360 }} />
      </Field>
      <div>
        <div className="section-label">Quero receber</div>
        <div className="wa-alerts">
          <div className="wa-alert-row">
            <Package size={20} />
            <div className="grow">
              <Switch
                checked={f.stockLow}
                onChange={(v) => set('stockLow', v)}
                label="Estoque baixo"
                description="Quando um produto chega ao estoque mínimo, com sugestão de reposição. Um aviso por produto até ele ser reposto."
              />
            </div>
          </div>
          <div className="wa-alert-row">
            <Wallet size={20} />
            <div className="grow">
              <Switch
                checked={f.cashClosed}
                onChange={(v) => set('cashClosed', v)}
                label="Fechamento de caixa"
                description="Resumo de cada caixa fechado: total recebido por forma de pagamento e diferença na gaveta."
              />
            </div>
          </div>
        </div>
      </div>
      <Help icon={<ShieldCheck size={16} />}>
        Sem internet, os avisos esperam na fila e saem quando a conexão voltar — e só se ainda fizerem sentido (por exemplo, se o
        estoque continuar baixo). Credenciais ficam cifradas neste PC.
      </Help>
      {result && (
        <div className={`banner ${result.ok ? 'success' : 'danger'}`} role={result.ok ? 'status' : 'alert'}>
          {result.ok ? <CircleCheck size={18} style={{ color: 'var(--green)', flex: 'none' }} /> : <Info size={18} style={{ color: 'var(--red)', flex: 'none' }} />}
          <div className="grow">{result.text}</div>
        </div>
      )}
      <div className="wa-actions">
        <Button variant="plain" icon={<ChevronLeft size={16} />} onClick={onBack}>Voltar</Button>
        <span className="spacer" />
        <Button icon={<Send size={16} />} loading={busy === 'test'} disabled={!phone || busy !== null} onClick={sendTest}>
          {provider === 'evolution' ? 'Enviar mensagem de teste' : 'Salvar e enviar teste'}
        </Button>
        <Button variant="primary" icon={<Check size={16} />} loading={busy === 'save'} disabled={!phone || busy !== null} onClick={save}>
          {isCurrent ? 'Salvar alterações' : 'Salvar e ativar'}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- fila

function QueueCard({ items, onReload }: { items: QueueItem[] | null; onReload: () => void }) {
  return (
    <Card title="Fila de avisos" flush actions={<Button variant="plain" size="small" icon={<RefreshCw size={14} />} onClick={onReload}>Atualizar</Button>}>
      <div className="list">
        {items?.length === 0 && <div className="list-item muted">Nenhum aviso ainda.</div>}
        {items?.map((n) => (
          <div key={n.id} className="list-item">
            <div className="grow">
              <div>{KIND_LABEL[n.kind] ?? n.kind}</div>
              <div className="tiny muted">{fmtDateTime(n.created_at)}{n.last_error && ` · ${n.last_error}`}</div>
            </div>
            <Badge color={n.status === 'sent' ? 'green' : n.status === 'pending' ? 'orange' : n.status === 'failed' ? 'red' : undefined}>
              {{ sent: 'Enviado', pending: 'Na fila', failed: 'Falhou', discarded: 'Descartado' }[n.status] ?? n.status}
            </Badge>
          </div>
        ))}
      </div>
    </Card>
  );
}
