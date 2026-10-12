import { Bell, Building2, Cloud, Database, Printer, SlidersHorizontal, Smartphone, Trash2, Tv, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../../components/brand';
import { Button, Card, ErrorBox, Field, Input, Loading, MoneyInput, PageHeader, Select, Switch, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { applyBrandColors, useSession } from '../../lib/session';

export function SettingsHome() {
  const { can } = useSession();
  const items: { to: string; icon: ReactNode; title: string; text: string; show: boolean }[] = [
    { to: '/configuracoes/identidade', icon: <Building2 size={22} />, title: 'Identidade do estabelecimento', text: 'Nome, logotipo, cores, capa, telefone e redes sociais.', show: can('settings.manage') },
    { to: '/configuracoes/operacao', icon: <SlidersHorizontal size={22} />, title: 'Operação', text: 'Estoque, caixa, taxa de serviço, narguilés e LGPD.', show: can('settings.manage') },
    { to: '/configuracoes/dispositivos', icon: <Smartphone size={22} />, title: 'Conectar dispositivo', text: 'QR Code para celulares e tablets da equipe.', show: can('devices.manage') },
    { to: '/configuracoes/tv', icon: <Tv size={22} />, title: 'Conectar TV', text: 'Painel de retirada com chamada por voz.', show: can('devices.manage') },
    { to: '/configuracoes/impressoras', icon: <Printer size={22} />, title: 'Impressoras', text: 'Impressoras térmicas ESC/POS, setores e histórico.', show: can('printers.manage') },
    { to: '/configuracoes/sincronizacao', icon: <Cloud size={22} />, title: 'Sincronização', text: 'Conexão com o painel online do proprietário.', show: can('settings.manage') },
    { to: '/configuracoes/notificacoes', icon: <Bell size={22} />, title: 'Notificações', text: 'Alertas de estoque pelo WhatsApp.', show: can('settings.manage') },
    { to: '/configuracoes/backup', icon: <Database size={22} />, title: 'Backup', text: 'Cópias de segurança do banco de dados local.', show: can('settings.manage') },
  ];
  return (
    <div className="stack-l">
      <PageHeader title="Configurações" />
      <div className="grid-auto">
        {items.filter((i) => i.show).map((i) => (
          <Link key={i.to} to={i.to} className="card" style={{ color: 'inherit' }}>
            <div style={{ color: 'var(--accent)' }}>{i.icon}</div>
            <h3 style={{ marginTop: 10 }}>{i.title}</h3>
            <p className="small muted" style={{ marginTop: 4 }}>{i.text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

interface Identity {
  tradeName: string;
  legalName: string | null;
  cnpj: string | null;
  phone: string | null;
  address: Record<string, string>;
  primaryColor: string;
  secondaryColor: string;
  instagram: string | null;
  facebook: string | null;
  whatsapp: string | null;
  website: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
}

export function IdentitySettings() {
  const toast = useToast();
  const { branding, refreshBranding } = useSession();
  const { data, error, reload } = useLoad(() => api.get<Identity>('/api/settings/identity'));
  const [f, setF] = useState<Identity | null>(null);
  const [busy, setBusy] = useState(false);
  if (data && !f) setF({ ...data, address: { street: '', number: '', complement: '', district: '', city: '', state: '', zip: '', ...data.address } });
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!f) return <Loading />;

  const upload = async (slot: 'logo' | 'cover', file: File | undefined) => {
    if (!file) return;
    try {
      await api.upload(`/api/settings/identity/${slot}`, file);
      await refreshBranding();
      void reload();
      setF(null);
      toast.success(slot === 'logo' ? 'Logotipo atualizado' : 'Capa atualizada');
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (slot: 'logo' | 'cover') => {
    await api.del(`/api/settings/identity/${slot}`);
    await refreshBranding();
    setF(null);
    void reload();
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings/identity', {
        tradeName: f.tradeName, legalName: f.legalName || null, cnpj: f.cnpj || null, phone: f.phone || null, address: f.address,
        primaryColor: f.primaryColor.toUpperCase(), secondaryColor: f.secondaryColor.toUpperCase(), instagram: f.instagram || null,
        facebook: f.facebook || null, whatsapp: f.whatsapp || null, website: f.website || null,
      });
      await refreshBranding();
      toast.success('Identidade atualizada em todas as telas, cupons e TV');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof Identity, v: string) => setF({ ...f, [k]: v });
  const setAddr = (k: string, v: string) => setF({ ...f, address: { ...f.address, [k]: v } });

  return (
    <div className="stack-l">
      <PageHeader title="Identidade do estabelecimento" subtitle="Aplicada no login, no sistema, na TV, nos cupons e no painel online." actions={<Button variant="primary" loading={busy} onClick={save}>Salvar</Button>} />
      <div className="grid-2">
        <Card title="Logotipo">
          <div className="row" style={{ gap: 18 }}>
            <Logo branding={branding} size={88} />
            <div className="col">
              <label className="btn"><Upload size={16} /> Enviar logotipo<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => upload('logo', e.target.files?.[0])} /></label>
              {data?.logoUrl && <Button variant="plain" icon={<Trash2 size={15} />} onClick={() => remove('logo')}>Remover</Button>}
              <span className="tiny muted">Sem logotipo, exibimos as iniciais com a cor principal.</span>
            </div>
          </div>
        </Card>
        <Card title="Imagem de capa">
          <div className="row" style={{ gap: 18 }}>
            <div style={{ width: 140, height: 88, borderRadius: 14, background: data?.coverUrl ? `center/cover url(${data.coverUrl})` : 'var(--fill)' }} />
            <div className="col">
              <label className="btn"><Upload size={16} /> Enviar capa<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => upload('cover', e.target.files?.[0])} /></label>
              {data?.coverUrl && <Button variant="plain" icon={<Trash2 size={15} />} onClick={() => remove('cover')}>Remover</Button>}
              <span className="tiny muted">Usada como fundo na tela de login.</span>
            </div>
          </div>
        </Card>
      </div>
      <Card title="Dados">
        <div className="stack">
          <div className="grid-2">
            <Field label="Nome fantasia"><Input value={f.tradeName} onChange={(e) => set('tradeName', e.target.value)} /></Field>
            <Field label="Razão social"><Input value={f.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} /></Field>
            <Field label="CNPJ"><Input value={f.cnpj ?? ''} onChange={(e) => set('cnpj', e.target.value)} /></Field>
            <Field label="Telefone"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
          </div>
          <div className="grid-3">
            <Field label="Rua"><Input value={f.address.street ?? ''} onChange={(e) => setAddr('street', e.target.value)} /></Field>
            <Field label="Número"><Input value={f.address.number ?? ''} onChange={(e) => setAddr('number', e.target.value)} /></Field>
            <Field label="Bairro"><Input value={f.address.district ?? ''} onChange={(e) => setAddr('district', e.target.value)} /></Field>
            <Field label="Cidade"><Input value={f.address.city ?? ''} onChange={(e) => setAddr('city', e.target.value)} /></Field>
            <Field label="UF"><Input maxLength={2} value={f.address.state ?? ''} onChange={(e) => setAddr('state', e.target.value.toUpperCase())} /></Field>
            <Field label="CEP"><Input value={f.address.zip ?? ''} onChange={(e) => setAddr('zip', e.target.value)} /></Field>
          </div>
        </div>
      </Card>
      <div className="grid-2">
        <Card title="Cores">
          <div className="grid-2">
            <Field label="Principal"><div className="row"><input type="color" value={f.primaryColor} onChange={(e) => { set('primaryColor', e.target.value); applyBrandColors(e.target.value, f.secondaryColor); }} /><span className="mono small">{f.primaryColor.toUpperCase()}</span></div></Field>
            <Field label="Secundária"><div className="row"><input type="color" value={f.secondaryColor} onChange={(e) => set('secondaryColor', e.target.value)} /><span className="mono small">{f.secondaryColor.toUpperCase()}</span></div></Field>
          </div>
        </Card>
        <Card title="Redes sociais">
          <div className="grid-2">
            <Field label="Instagram"><Input value={f.instagram ?? ''} onChange={(e) => set('instagram', e.target.value)} placeholder="seubar" /></Field>
            <Field label="Facebook"><Input value={f.facebook ?? ''} onChange={(e) => set('facebook', e.target.value)} /></Field>
            <Field label="WhatsApp"><Input value={f.whatsapp ?? ''} onChange={(e) => set('whatsapp', e.target.value)} /></Field>
            <Field label="Site"><Input value={f.website ?? ''} onChange={(e) => set('website', e.target.value)} /></Field>
          </div>
        </Card>
      </div>
    </div>
  );
}

interface Operation {
  allowNegativeStock: boolean;
  serviceFeeBp: number;
  requireCashSessionForPayments: boolean;
  defaultOpeningBalanceCents: number;
  defaultGramsPerRosh: number;
  hookahRequiresCleaning: boolean;
  requireCustomerPhone: boolean;
  requireCustomerCpf: boolean;
  autoPrintOrders: boolean;
  pickupPlace: string;
  tvVoiceEnabled: boolean;
  lowStockAlertsEnabled: boolean;
}

export function OperationSettings() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<Operation>('/api/settings/operation'));
  const [f, setF] = useState<Operation | null>(null);
  if (data && !f) setF(data);
  if (!f) return <Loading />;
  const set = <K extends keyof Operation>(k: K, v: Operation[K]) => setF({ ...f, [k]: v });
  return (
    <div className="stack-l">
      <PageHeader title="Operação" actions={<Button variant="primary" onClick={async () => { try { await api.put('/api/settings/operation', f); toast.success('Configurações salvas'); void reload(); } catch (e) { toast.error(e); } }}>Salvar</Button>} />
      <div className="grid-2">
        <Card title="Estoque">
          <Switch checked={!f.allowNegativeStock} onChange={(v) => set('allowNegativeStock', !v)} label="Bloquear vendas sem saldo" />
          <Switch checked={f.lowStockAlertsEnabled} onChange={(v) => set('lowStockAlertsEnabled', v)} label="Alertas de estoque mínimo" />
        </Card>
        <Card title="Caixa e comandas">
          <Switch checked={f.requireCashSessionForPayments} onChange={(v) => set('requireCashSessionForPayments', v)} label="Exigir caixa aberto para pagamentos" />
          <div className="grid-2" style={{ marginTop: 8 }}>
            <Field label="Saldo inicial sugerido"><MoneyInput value={f.defaultOpeningBalanceCents} onChange={(v) => set('defaultOpeningBalanceCents', v ?? 0)} /></Field>
            <Field label="Taxa de serviço padrão">
              <Select value={f.serviceFeeBp} onChange={(e) => set('serviceFeeBp', Number(e.target.value))}>{[0, 500, 1000, 1200, 1300, 1500].map((v) => <option key={v} value={v}>{v ? `${v / 100}%` : 'Sem taxa'}</option>)}</Select>
            </Field>
          </div>
        </Card>
        <Card title="Pedidos, impressão e TV">
          <Switch checked={f.autoPrintOrders} onChange={(v) => set('autoPrintOrders', v)} label="Imprimir pedidos automaticamente" />
          <Switch checked={f.tvVoiceEnabled} onChange={(v) => set('tvVoiceEnabled', v)} label="Anúncio por voz na TV" />
          <Field label="Local de retirada (anúncio)" hint='Ex.: "no balcão", "no caixa"'><Input value={f.pickupPlace} onChange={(e) => set('pickupPlace', e.target.value)} /></Field>
        </Card>
        <Card title="Narguilés">
          <Field label="Consumo padrão por rosh (g)" hint="Ponto de partida; cada sessão pode usar outro valor.">
            <Input type="number" min={1} max={100} step={0.5} value={f.defaultGramsPerRosh / 1000} onChange={(e) => set('defaultGramsPerRosh', Math.round(Number(e.target.value) * 1000))} />
          </Field>
          <Switch checked={f.hookahRequiresCleaning} onChange={(v) => set('hookahRequiresCleaning', v)} label="Limpeza obrigatória após devolução" />
        </Card>
        <Card title="Dados do cliente (LGPD)">
          <Switch checked={f.requireCustomerPhone} onChange={(v) => set('requireCustomerPhone', v)} label="Telefone obrigatório" />
          <Switch checked={f.requireCustomerCpf} onChange={(v) => set('requireCustomerCpf', v)} label="CPF obrigatório" description="Ative somente se houver necessidade legal ou contratual." />
        </Card>
      </div>
    </div>
  );
}

export function BackupSettings() {
  const toast = useToast();
  const [file, setFile] = useState<string | null>(null);
  return (
    <div className="stack-l">
      <PageHeader title="Backup" />
      <Card>
        <div className="stack">
          <p className="muted">O RupBar cria automaticamente uma cópia diária do banco de dados na pasta de dados do programa. Você também pode gerar uma cópia agora e guardá-la em um pendrive ou na nuvem.</p>
          <Button variant="primary" style={{ alignSelf: 'flex-start' }} icon={<Database size={16} />} onClick={async () => { try { const r = await api.post<{ file: string }>('/api/system/backup'); setFile(r.file); toast.success('Backup criado'); } catch (e) { toast.error(e); } }}>Criar backup agora</Button>
          {file && <div className="banner success"><span>Arquivo salvo em <span className="mono">{file}</span></span></div>}
        </div>
      </Card>
    </div>
  );
}
