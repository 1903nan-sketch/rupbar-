import { checkPasswordStrength, initials, isValidCnpj, isValidEmail, normalizePhoneBR } from '@rupbar/core';
import { ArrowLeft, ArrowRight, Check, Monitor, Printer, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo, RupbarSignature } from '../components/brand';
import { Button, Card, ErrorBox, Field, Input, MoneyInput, Select, Switch, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { applyBrandColors, useSession } from '../lib/session';

const COLORS = ['#0A84FF', '#FF9F0A', '#FF375F', '#30D158', '#BF5AF2', '#64D2FF', '#FFD60A', '#AC8E68', '#1C1C1E'];
const SECONDARY = ['#1C1C1E', '#2C2C2E', '#0B1F33', '#3A1F0B', '#13261A', '#F5F5F7'];

const STEPS = ['Estabelecimento', 'Identidade visual', 'Proprietário', 'Estoque', 'Caixa', 'Impressoras', 'Concluir'] as const;

export function SetupPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { refresh, refreshBranding } = useSession();
  const status = useLoad(() => api.get<{ configured: boolean; isLocal: boolean }>('/api/setup/status'));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [identity, setIdentity] = useState({
    tradeName: '', legalName: '', cnpj: '', phone: '', primaryColor: '#0A84FF', secondaryColor: '#1C1C1E',
    address: { street: '', number: '', complement: '', district: '', city: '', state: '', zip: '' },
    instagram: '',
  });
  const [logo, setLogo] = useState<File | null>(null);
  const logoUrl = useMemo(() => (logo ? URL.createObjectURL(logo) : null), [logo]);
  const [owner, setOwner] = useState({ name: '', email: '', password: '', confirm: '' });
  const [op, setOp] = useState({
    allowNegativeStock: false, lowStockAlertsEnabled: true, defaultGramsPerRosh: 12, hookahRequiresCleaning: true,
    requireCashSessionForPayments: true, defaultOpeningBalanceCents: 0 as number | null, serviceFeePercent: 0,
    requireCustomerPhone: false, requireCustomerCpf: false, autoPrintOrders: true,
  });
  const [seedCategories, setSeedCategories] = useState(true);
  const [printer, setPrinter] = useState({ enabled: false, name: 'Cozinha', host: '', paper: 80, stations: ['kitchen'] as string[] });

  useEffect(() => applyBrandColors(identity.primaryColor, identity.secondaryColor), [identity.primaryColor, identity.secondaryColor]);

  if (status.loading) return null;
  if (status.data?.configured) {
    nav('/login', { replace: true });
    return null;
  }
  if (status.data && !status.data.isLocal) {
    return (
      <div className="center-page">
        <Card className="login-card">
          <Monitor size={40} style={{ margin: '0 auto', color: 'var(--accent)' }} />
          <h2>Configuração inicial pendente</h2>
          <p className="muted">Por segurança, a primeira configuração do RupBar deve ser feita no computador do bar.</p>
        </Card>
      </div>
    );
  }

  const strength = checkPasswordStrength(owner.password, [owner.name, owner.email]);
  const stepError = (): string | null => {
    if (step === 0) {
      if (identity.tradeName.trim().length < 2) return 'Informe o nome do estabelecimento.';
      if (identity.cnpj && !isValidCnpj(identity.cnpj)) return 'CNPJ inválido.';
      if (identity.phone && !normalizePhoneBR(identity.phone)) return 'Telefone inválido (inclua o DDD).';
    }
    if (step === 2) {
      if (owner.name.trim().length < 2) return 'Informe o seu nome.';
      if (!isValidEmail(owner.email)) return 'E-mail inválido.';
      if (!strength.ok) return strength.problems.join(' ');
      if (owner.password !== owner.confirm) return 'As senhas não conferem.';
    }
    if (step === 5 && printer.enabled && !printer.host.trim()) return 'Informe o IP da impressora ou desative esta etapa.';
    return null;
  };

  const next = () => {
    const e = stepError();
    setError(e);
    if (!e) setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/setup', {
        identity: {
          ...identity,
          legalName: identity.legalName || null,
          cnpj: identity.cnpj || null,
          phone: identity.phone || null,
          instagram: identity.instagram.replace(/^@/, '') || null,
        },
        owner: { name: owner.name, email: owner.email, password: owner.password },
        operation: {
          allowNegativeStock: op.allowNegativeStock,
          lowStockAlertsEnabled: op.lowStockAlertsEnabled,
          defaultGramsPerRosh: Math.round(op.defaultGramsPerRosh * 1000),
          hookahRequiresCleaning: op.hookahRequiresCleaning,
          requireCashSessionForPayments: op.requireCashSessionForPayments,
          defaultOpeningBalanceCents: op.defaultOpeningBalanceCents ?? 0,
          serviceFeeBp: Math.round(op.serviceFeePercent * 100),
          requireCustomerPhone: op.requireCustomerPhone,
          requireCustomerCpf: op.requireCustomerCpf,
          autoPrintOrders: op.autoPrintOrders,
        },
        seedCategories,
      });
      if (logo) await api.upload('/api/settings/identity/logo', logo).catch(() => toast.error('Não foi possível enviar o logotipo. Tente em Configurações.'));
      if (printer.enabled) {
        await api
          .post('/api/printers', { name: printer.name, transport: 'network', host: printer.host, port: 9100, paper: printer.paper, stations: printer.stations, autoPrint: true })
          .catch(() => toast.error('Não foi possível salvar a impressora. Configure em Impressoras.'));
      }
      await refreshBranding();
      await refresh();
      toast.success('Tudo pronto! Bem-vindo ao RupBar.');
      nav('/configuracoes/dispositivos?bemvindo=1', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const preview = { logoUrl, initials: identity.tradeName.trim() ? initials(identity.tradeName) : 'RB', tradeName: identity.tradeName };
  const setAddr = (k: keyof typeof identity.address, v: string) => setIdentity({ ...identity, address: { ...identity.address, [k]: v } });

  return (
    <div className="setup">
      <aside className="setup-aside glass">
        <div className="row" style={{ gap: 12 }}>
          <Logo branding={preview} size={48} />
          <div>
            <div className="strong">{identity.tradeName || 'Seu estabelecimento'}</div>
            <div className="small muted">Configuração inicial</div>
          </div>
        </div>
        <div className="setup-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
              <span className="n">{i < step ? <Check size={14} /> : i + 1}</span>
              {s}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 'auto' }}>
          <RupbarSignature />
        </div>
      </aside>
      <main className="setup-main stack-l">
        <div>
          <div className="small muted">Etapa {step + 1} de {STEPS.length}</div>
          <h1>{STEPS[step]}</h1>
        </div>

        {step === 0 && (
          <div className="stack">
            <p className="muted">Bem-vindo ao RupBar. Vamos deixar tudo pronto em poucos minutos. Estes dados aparecem no sistema, nos cupons e na TV.</p>
            <Field label="Nome fantasia *"><Input large autoFocus value={identity.tradeName} onChange={(e) => setIdentity({ ...identity, tradeName: e.target.value })} placeholder="Ex.: Bar do Zé" /></Field>
            <div className="grid-2">
              <Field label="Razão social" hint="Quando aplicável"><Input value={identity.legalName} onChange={(e) => setIdentity({ ...identity, legalName: e.target.value })} /></Field>
              <Field label="CNPJ" hint="Quando aplicável"><Input inputMode="numeric" value={identity.cnpj} onChange={(e) => setIdentity({ ...identity, cnpj: e.target.value })} placeholder="00.000.000/0000-00" /></Field>
              <Field label="Telefone"><Input inputMode="tel" value={identity.phone} onChange={(e) => setIdentity({ ...identity, phone: e.target.value })} placeholder="(11) 99999-9999" /></Field>
              <Field label="Instagram"><Input value={identity.instagram} onChange={(e) => setIdentity({ ...identity, instagram: e.target.value })} placeholder="@seubar" /></Field>
            </div>
            <div className="section-label">Endereço</div>
            <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
              <Field label="Rua"><Input value={identity.address.street} onChange={(e) => setAddr('street', e.target.value)} /></Field>
              <Field label="Número"><Input value={identity.address.number} onChange={(e) => setAddr('number', e.target.value)} /></Field>
            </div>
            <div className="grid-3">
              <Field label="Bairro"><Input value={identity.address.district} onChange={(e) => setAddr('district', e.target.value)} /></Field>
              <Field label="Cidade"><Input value={identity.address.city} onChange={(e) => setAddr('city', e.target.value)} /></Field>
              <div className="grid-2">
                <Field label="UF"><Input maxLength={2} value={identity.address.state} onChange={(e) => setAddr('state', e.target.value.toUpperCase())} /></Field>
                <Field label="CEP"><Input inputMode="numeric" value={identity.address.zip} onChange={(e) => setAddr('zip', e.target.value)} /></Field>
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="stack-l">
            <div className="row top" style={{ gap: 24 }}>
              <Logo branding={preview} size={96} />
              <div className="stack grow">
                <Field label="Logotipo" hint="PNG, JPG ou WEBP até 2 MB. Sem logotipo, usamos as iniciais com a sua cor.">
                  <div className="row">
                    <label className="btn">
                      <Upload size={16} /> Escolher imagem
                      <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => setLogo(e.target.files?.[0] ?? null)} />
                    </label>
                    {logo && <Button variant="plain" onClick={() => setLogo(null)}>Remover</Button>}
                  </div>
                </Field>
              </div>
            </div>
            <Field label="Cor principal">
              <div className="row wrap">
                <div className="color-swatches">
                  {COLORS.map((c) => (
                    <button key={c} type="button" aria-label={c} className={identity.primaryColor.toUpperCase() === c ? 'active' : ''} style={{ background: c }} onClick={() => setIdentity({ ...identity, primaryColor: c })} />
                  ))}
                </div>
                <input type="color" value={identity.primaryColor} onChange={(e) => setIdentity({ ...identity, primaryColor: e.target.value.toUpperCase() })} aria-label="Cor personalizada" />
              </div>
            </Field>
            <Field label="Cor secundária">
              <div className="row wrap">
                <div className="color-swatches">
                  {SECONDARY.map((c) => (
                    <button key={c} type="button" aria-label={c} className={identity.secondaryColor.toUpperCase() === c ? 'active' : ''} style={{ background: c }} onClick={() => setIdentity({ ...identity, secondaryColor: c })} />
                  ))}
                </div>
                <input type="color" value={identity.secondaryColor} onChange={(e) => setIdentity({ ...identity, secondaryColor: e.target.value.toUpperCase() })} aria-label="Cor secundária personalizada" />
              </div>
            </Field>
            <Card>
              <div className="row between">
                <div className="row">
                  <Logo branding={preview} size={36} />
                  <strong>{identity.tradeName || 'Seu estabelecimento'}</strong>
                </div>
                <Button variant="primary">Botão de exemplo</Button>
              </div>
            </Card>
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <p className="muted">Esta é a conta do proprietário: acesso administrativo completo, criação de funcionários e registro de perdas.</p>
            <Field label="Seu nome *"><Input autoFocus value={owner.name} onChange={(e) => setOwner({ ...owner, name: e.target.value })} /></Field>
            <Field label="E-mail do proprietário *" hint="Usado para entrar no RupBar e no painel online."><Input type="email" autoComplete="email" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} /></Field>
            <div className="grid-2">
              <Field label="Senha *" hint="Mínimo de 8 caracteres, com letras e números.">
                <Input type="password" autoComplete="new-password" value={owner.password} onChange={(e) => setOwner({ ...owner, password: e.target.value })} />
              </Field>
              <Field label="Confirme a senha *"><Input type="password" autoComplete="new-password" value={owner.confirm} onChange={(e) => setOwner({ ...owner, confirm: e.target.value })} /></Field>
            </div>
            {owner.password && (
              <div className="small">
                {strength.ok ? <span className="success-text">✓ Senha forte</span> : strength.problems.map((p) => <div key={p} className="warning-text">• {p}</div>)}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <Card>
            <div className="stack">
              <Switch checked={!op.allowNegativeStock} onChange={(v) => setOp({ ...op, allowNegativeStock: !v })} label="Bloquear vendas sem saldo em estoque" description="Recomendado. Se desativado, o sistema permite vender e o saldo fica negativo até a próxima entrada." />
              <Switch checked={op.lowStockAlertsEnabled} onChange={(v) => setOp({ ...op, lowStockAlertsEnabled: v })} label="Alertas de estoque mínimo" description="Avisos no sistema, no painel online e (opcional) no WhatsApp." />
              <Switch checked={seedCategories} onChange={setSeedCategories} label="Criar categorias iniciais" description="Cervejas, Destilados, Drinks, Porções, Essências, Carvão, Narguilés e outras." />
              <div className="divider" />
              <div className="grid-2">
                <Field label="Consumo padrão de essência por rosh" hint="Valor inicial sugerido; ajuste à realidade da casa. Cada sessão pode usar outro valor.">
                  <div className="input-group">
                    <input className="input num" type="number" min={1} max={100} step={0.5} value={op.defaultGramsPerRosh} onChange={(e) => setOp({ ...op, defaultGramsPerRosh: Number(e.target.value) })} />
                    <span className="suffix">g</span>
                  </div>
                </Field>
              </div>
              <Switch checked={op.hookahRequiresCleaning} onChange={(v) => setOp({ ...op, hookahRequiresCleaning: v })} label="Narguilé vai para limpeza após devolução" />
            </div>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <div className="stack">
              <Switch checked={op.requireCashSessionForPayments} onChange={(v) => setOp({ ...op, requireCashSessionForPayments: v })} label="Exigir caixa aberto para receber pagamentos" description="Recomendado para conferência no fechamento." />
              <div className="grid-2">
                <Field label="Saldo inicial sugerido (troco)"><MoneyInput value={op.defaultOpeningBalanceCents} onChange={(v) => setOp({ ...op, defaultOpeningBalanceCents: v })} /></Field>
                <Field label="Taxa de serviço padrão">
                  <Select value={op.serviceFeePercent} onChange={(e) => setOp({ ...op, serviceFeePercent: Number(e.target.value) })}>
                    <option value={0}>Sem taxa</option>
                    <option value={10}>10%</option>
                    <option value={12}>12%</option>
                    <option value={13}>13%</option>
                    <option value={15}>15%</option>
                  </Select>
                </Field>
              </div>
              <div className="divider" />
              <div className="section-label">Dados do cliente (LGPD)</div>
              <p className="small muted">Colete apenas o necessário. CPF e telefone ficam somente no PC do bar, aparecem mascarados e nunca são impressos nem exibidos na TV.</p>
              <Switch checked={op.requireCustomerPhone} onChange={(v) => setOp({ ...op, requireCustomerPhone: v })} label="Telefone obrigatório ao abrir comanda" />
              <Switch checked={op.requireCustomerCpf} onChange={(v) => setOp({ ...op, requireCustomerCpf: v })} label="CPF obrigatório ao abrir comanda" />
            </div>
          </Card>
        )}

        {step === 5 && (
          <div className="stack">
            <Card>
              <div className="stack">
                <Switch checked={op.autoPrintOrders} onChange={(v) => setOp({ ...op, autoPrintOrders: v })} label="Imprimir pedidos automaticamente" description="Cada setor (cozinha, balcão) recebe seu próprio cupom." />
                <Switch checked={printer.enabled} onChange={(v) => setPrinter({ ...printer, enabled: v })} label="Adicionar uma impressora de rede agora" description="Impressoras USB e outras podem ser adicionadas depois em Configurações → Impressoras." />
                {printer.enabled && (
                  <div className="grid-2">
                    <Field label="Nome"><Input value={printer.name} onChange={(e) => setPrinter({ ...printer, name: e.target.value })} /></Field>
                    <Field label="Endereço IP" hint="Impressoras ESC/POS de rede usam a porta 9100."><Input value={printer.host} onChange={(e) => setPrinter({ ...printer, host: e.target.value })} placeholder="192.168.0.200" /></Field>
                    <Field label="Papel">
                      <Select value={printer.paper} onChange={(e) => setPrinter({ ...printer, paper: Number(e.target.value) })}>
                        <option value={80}>80 mm</option>
                        <option value={58}>58 mm</option>
                      </Select>
                    </Field>
                    <Field label="Setor">
                      <Select value={printer.stations[0]} onChange={(e) => setPrinter({ ...printer, stations: [e.target.value] })}>
                        <option value="kitchen">Cozinha</option>
                        <option value="bar">Balcão/Bebidas</option>
                      </Select>
                    </Field>
                  </div>
                )}
              </div>
            </Card>
            <div className="banner"><Printer size={18} /> Você poderá testar a impressão em Configurações → Impressoras.</div>
          </div>
        )}

        {step === 6 && (
          <div className="stack">
            <Card>
              <div className="stack">
                <div className="row"><Logo branding={preview} size={44} /><div><div className="strong">{identity.tradeName}</div><div className="small muted">{owner.email}</div></div></div>
                <div className="small muted">
                  Estoque: {op.allowNegativeStock ? 'permite saldo negativo' : 'bloqueia venda sem saldo'} · Rosh padrão: {op.defaultGramsPerRosh} g · Taxa de serviço: {op.serviceFeePercent}%
                </div>
              </div>
            </Card>
            <p className="muted">Ao concluir, mostraremos o QR Code para conectar celulares e tablets da equipe pela rede Wi-Fi do bar.</p>
          </div>
        )}

        {error && <ErrorBox error={error} />}

        <div className="row between">
          <Button icon={<ArrowLeft size={16} />} disabled={step === 0 || busy} onClick={() => { setError(null); setStep(step - 1); }}>Voltar</Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" size="large" onClick={next}>Continuar <ArrowRight size={16} /></Button>
          ) : (
            <Button variant="primary" size="large" loading={busy} onClick={finish}>Concluir configuração</Button>
          )}
        </div>
      </main>
    </div>
  );
}
