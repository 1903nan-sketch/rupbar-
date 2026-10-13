import { HOOKAH_STATUS, type HookahStatus } from '@rupbar/core';
import { History, Pencil, Plus, RotateCcw, Sparkles, Timer, Trash2, Users, Wind, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Switch, Tabs, useToast } from '../components/ui';
import { api, requestId } from '../lib/api';
import { dayRange, elapsed, fmtDateTime, formatBRL, formatQty } from '../lib/format';
import { useLoad, useNow } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { ReasonModal } from '../components/OwnerActions';
import '../styles/hookah.css';
import type { ComandaSummary } from './Comandas';
import { OpenComandaModal } from './Comandas';
import type { Product } from './Products';

interface ActiveSession {
  id: string;
  startedAt: string;
  customerName: string;
  roshCount: number;
  comandaNumber: number;
  comandaDisplayNumber: number;
  table: string | null;
  mode: 'legacy' | 'house' | 'own';
  chargedCents: number | null;
  currentCharge: { totalCents: number; minutes: number; periods: number } | null;
}
interface Hookah {
  id: string;
  code: string;
  model: string;
  status: HookahStatus;
  statusLabel: string;
  notes: string | null;
  active: boolean;
  session: null | ActiveSession;
}
interface Pricing {
  rentalCents: number;
  roshSwapCents: number;
  ownRoshCents: number;
}
interface SessionRow {
  id: string;
  comanda_id: string;
  customer_name: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  charge_cents: number | null;
  charged_cents: number;
  rosh_count: number;
  mode: 'legacy' | 'house' | 'own';
  code: string;
  model: string;
  owner: 'house' | 'customer';
  comanda_display_number: number;
  table_label: string | null;
}
/** Locação ativa em formato único (aparelho da casa ou narguilé próprio). */
interface RentalTarget {
  sessionId: string;
  title: string;
  mode: 'legacy' | 'house' | 'own';
  customerName: string;
  comandaDisplayNumber: number;
  chargedCents: number | null;
  legacyCharge: { totalCents: number; minutes: number; periods: number } | null;
}

const STATUS_COLOR: Record<HookahStatus, 'green' | 'orange' | 'blue' | 'red' | undefined> = {
  available: 'green', rented: 'blue', cleaning: 'orange', maintenance: 'red', inactive: undefined,
};

export function HookahsPage() {
  const [tab, setTab] = useState<'aparelhos' | 'historico' | 'indicadores'>('aparelhos');
  const { can } = useSession();
  return (
    <div className="stack">
      <PageHeader title="Narguilés" subtitle="Aluguel com essência e carvão inclusos, trocas de rosh e narguilé próprio do cliente." />
      <Tabs value={tab} onChange={setTab} options={[{ value: 'aparelhos', label: 'Em uso e aparelhos' }, { value: 'historico', label: 'Locações' }, { value: 'indicadores', label: 'Indicadores', hidden: !can('reports.operational') }]} />
      {tab === 'aparelhos' && <Devices />}
      {tab === 'historico' && <SessionsHistory />}
      {tab === 'indicadores' && <Indicators />}
    </div>
  );
}

function usePricing() {
  return useLoad(() => api.get<Pricing>('/api/hookah/pricing'));
}

function PricingCard({ pricing, onEdit }: { pricing: Pricing; onEdit?: () => void }) {
  return (
    <div className="card hookah-prices">
      <div className="hookah-price"><span className="small muted">Aluguel</span><strong className="num">{formatBRL(pricing.rentalCents)}</strong><span className="tiny muted">essência e carvão inclusos</span></div>
      <div className="hookah-price"><span className="small muted">Troca de rosh</span><strong className="num">{formatBRL(pricing.roshSwapCents)}</strong><span className="tiny muted">no aparelho da casa</span></div>
      <div className="hookah-price"><span className="small muted">Narguilé próprio</span><strong className="num">{formatBRL(pricing.ownRoshCents)}</strong><span className="tiny muted">essência + carvão por rosh</span></div>
      {onEdit && <Button icon={<Pencil size={15} />} onClick={onEdit}>Alterar valores</Button>}
    </div>
  );
}

function PricingModal({ pricing, onClose, onDone }: { pricing: Pricing; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<{ [K in keyof Pricing]: number | null }>(pricing);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Valores do narguilé" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={Object.values(f).some((v) => v === null)} onClick={async () => {
      setBusy(true);
      try { await api.put('/api/hookah/pricing', f); toast.success('Valores atualizados'); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Salvar</Button></>}>
      <div className="stack">
        <Field label="Aluguel do narguilé" hint="Já inclui a primeira essência e o carvão."><MoneyInput large autoFocus value={f.rentalCents} onChange={(v) => setF({ ...f, rentalCents: v })} /></Field>
        <Field label="Troca de rosh" hint="Cobrado a cada nova essência no aparelho da casa."><MoneyInput large value={f.roshSwapCents} onChange={(v) => setF({ ...f, roshSwapCents: v })} /></Field>
        <Field label="Narguilé próprio: essência + carvão" hint="Cliente traz o aparelho e compra a essência e o carvão aqui (a cada rosh)."><MoneyInput large value={f.ownRoshCents} onChange={(v) => setF({ ...f, ownRoshCents: v })} /></Field>
        <p className="tiny muted">Os novos valores valem para os próximos lançamentos; o que já está nas comandas não muda.</p>
      </div>
    </Modal>
  );
}

function Devices() {
  const { can } = useSession();
  const toast = useToast();
  const now = useNow(30_000);
  const { data, error, reload } = useLoad(() => api.get<Hookah[]>('/api/hookahs'));
  const own = useLoad(() => api.get<SessionRow[]>('/api/hookah-sessions?status=active'));
  const pricing = usePricing();
  const refresh = () => { void reload(); void own.reload(); };
  useRealtime(['hookah', 'comandas'], () => { refresh(); void pricing.reload(); });
  const [edit, setEdit] = useState<Hookah | 'new' | null>(null);
  const [rent, setRent] = useState<Hookah | 'own' | null>(null);
  const [rosh, setRosh] = useState<RentalTarget | null>(null);
  const [finish, setFinish] = useState<RentalTarget | null>(null);
  const [history, setHistory] = useState<Hookah | null>(null);
  const [editPricing, setEditPricing] = useState(false);

  const setStatus = async (h: Hookah, status: HookahStatus) => {
    try {
      await api.post(`/api/hookahs/${h.id}/status`, { status });
      void reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const targetOf = (h: Hookah): RentalTarget => ({
    sessionId: h.session!.id, title: `Narguilé ${h.code}`, mode: h.session!.mode, customerName: h.session!.customerName,
    comandaDisplayNumber: h.session!.comandaDisplayNumber, chargedCents: h.session!.chargedCents, legacyCharge: h.session!.currentCharge,
  });

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const ownActive = (own.data ?? []).filter((x) => x.owner === 'customer');
  return (
    <div className="stack">
      {pricing.data && <PricingCard pricing={pricing.data} onEdit={can('hookah.manage') ? () => setEditPricing(true) : undefined} />}
      <div className="row wrap">
        {can('hookah.rent') && <Button variant="primary" icon={<Users size={16} />} onClick={() => setRent('own')}>Narguilé próprio do cliente</Button>}
        {can('hookah.manage') && <Button icon={<Plus size={16} />} onClick={() => setEdit('new')}>Cadastrar aparelho</Button>}
      </div>

      {ownActive.length > 0 && (
        <>
          <div className="section-label">Narguilés próprios em uso</div>
          <div className="grid-auto">
            {ownActive.map((s) => (
              <Card key={s.id} className="hookah-card rented">
                <div className="row between"><span className="strong" style={{ fontSize: 18 }}>{s.model || 'Narguilé do cliente'}</span><Badge color="purple">Próprio</Badge></div>
                <div className="hookah-session">
                  <div className="strong">{s.customer_name || 'Sem nome'}</div>
                  <div className="small muted">Comanda {s.comanda_display_number}{s.table_label && ` · Mesa ${s.table_label}`}</div>
                  <div className="row between small" style={{ marginTop: 6 }}>
                    <span className="row"><Timer size={14} /> {elapsed(s.started_at, now)} · {s.rosh_count} rosh</span>
                    <span className="num strong">{formatBRL(s.charged_cents)}</span>
                  </div>
                </div>
                {can('hookah.rent') && (
                  <div className="row wrap" style={{ marginTop: 12, gap: 6 }}>
                    {(() => {
                      const t: RentalTarget = { sessionId: s.id, title: s.model || 'Narguilé próprio', mode: 'own', customerName: s.customer_name, comandaDisplayNumber: s.comanda_display_number, chargedCents: s.charged_cents, legacyCharge: null };
                      return (
                        <>
                          <Button size="small" icon={<Plus size={14} />} onClick={() => setRosh(t)}>Novo rosh</Button>
                          <Button size="small" variant="primary" icon={<RotateCcw size={14} />} onClick={() => setFinish(t)}>Encerrar</Button>
                        </>
                      );
                    })()}
                  </div>
                )}
              </Card>
            ))}
          </div>
          <div className="section-label">Aparelhos da casa</div>
        </>
      )}

      {data.length === 0 ? <Card><Empty icon={<Wind size={40} />} title="Nenhum narguilé cadastrado">Cadastre os aparelhos da casa para alugar.</Empty></Card> : (
        <div className="grid-auto stagger">
          {data.map((h) => (
            <Card key={h.id} className={`hookah-card ${h.status}`}>
              <div className="row between">
                <span className="strong" style={{ fontSize: 22 }}>{h.code}</span>
                <Badge color={STATUS_COLOR[h.status]}>{h.statusLabel}</Badge>
              </div>
              <div className="small muted">{h.model || 'Modelo não informado'}</div>
              {h.session && (
                <div className="hookah-session">
                  <div className="strong">{h.session.customerName || 'Sem nome'}</div>
                  <div className="small muted">Comanda {h.session.comandaDisplayNumber}{h.session.table && ` · Mesa ${h.session.table}`}</div>
                  <div className="row between small" style={{ marginTop: 6 }}>
                    <span className="row"><Timer size={14} /> {elapsed(h.session.startedAt, now)} · {h.session.roshCount} rosh</span>
                    <span className="num strong">{formatBRL(h.session.chargedCents ?? h.session.currentCharge?.totalCents ?? 0)}</span>
                  </div>
                </div>
              )}
              <div className="row wrap" style={{ marginTop: 14, gap: 6 }}>
                {h.status === 'available' && can('hookah.rent') && <Button size="small" variant="primary" onClick={() => setRent(h)}>Alugar</Button>}
                {h.status === 'rented' && can('hookah.rent') && (
                  <>
                    <Button size="small" icon={<Plus size={14} />} onClick={() => setRosh(targetOf(h))}>Troca de rosh</Button>
                    <Button size="small" variant="primary" icon={<RotateCcw size={14} />} onClick={() => setFinish(targetOf(h))}>Devolução</Button>
                  </>
                )}
                {h.status === 'cleaning' && can('hookah.manage') && <Button size="small" variant="success" icon={<Sparkles size={14} />} onClick={() => setStatus(h, 'available')}>Limpo</Button>}
                {h.status === 'maintenance' && can('hookah.manage') && <Button size="small" onClick={() => setStatus(h, 'available')}>Liberar</Button>}
                {(h.status === 'available' || h.status === 'cleaning') && can('hookah.manage') && <Button size="small" variant="plain" icon={<Wrench size={14} />} onClick={() => setStatus(h, 'maintenance')}>Manutenção</Button>}
                <Button size="small" variant="plain" icon={<History size={14} />} aria-label="Histórico" onClick={() => setHistory(h)} />
                {can('hookah.manage') && h.status !== 'rented' && <Button size="small" variant="plain" onClick={() => setEdit(h)}>Editar</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {edit && <HookahEditor hookah={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={reload} />}
      {rent && pricing.data && <RentModal hookah={rent === 'own' ? null : rent} pricing={pricing.data} onClose={() => setRent(null)} onDone={refresh} />}
      {rosh && pricing.data && <RoshModal target={rosh} pricing={pricing.data} onClose={() => setRosh(null)} onDone={refresh} />}
      {finish && <FinishModal target={finish} onClose={() => setFinish(null)} onDone={refresh} />}
      {history && <HistoryModal hookah={history} onClose={() => setHistory(null)} />}
      {editPricing && pricing.data && <PricingModal pricing={pricing.data} onClose={() => setEditPricing(false)} onDone={() => void pricing.reload()} />}
    </div>
  );
}

function HookahEditor({ hookah, onClose, onDone }: { hookah: Hookah | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ code: hookah?.code ?? '', model: hookah?.model ?? '', notes: hookah?.notes ?? '', active: hookah?.active ?? true });
  return (
    <Modal title={hookah ? `Narguilé ${hookah.code}` : 'Novo narguilé'} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={async () => {
      try {
        const body = { ...f, notes: f.notes || null };
        if (hookah) await api.put(`/api/hookahs/${hookah.id}`, body); else await api.post('/api/hookahs', body);
        toast.success('Aparelho salvo'); onDone(); onClose();
      } catch (e) { toast.error(e); }
    }}>Salvar</Button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Identificador *"><Input autoFocus value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="N-01" /></Field>
          <Field label="Modelo"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        </div>
        <p className="small muted">O valor do aluguel é o mesmo para todos os aparelhos: altere em “Alterar valores”.</p>
        <Field label="Observações"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Ativo" />
      </div>
    </Modal>
  );
}

function useHookahSupplies() {
  return useLoad(async () => {
    const [ps, op] = await Promise.all([api.get<Product[]>('/api/products'), api.get<{ defaultGramsPerRosh: number }>('/api/settings/operation/public').catch(() => ({ defaultGramsPerRosh: 12_000 }))]);
    return {
      essences: ps.filter((p) => p.measure === 'mass' && (p.categoryName === 'Essências' || /ess[eê]ncia/i.test(p.name))),
      coals: ps.filter((p) => p.measure === 'unit' && (p.categoryName === 'Carvão' || /carv[aã]o/i.test(p.name))),
      gramsPerRosh: op.defaultGramsPerRosh / 1000,
    };
  });
}

/** Seleção de sabores (mistura com gramas por sabor) e carvão. */
function ConsumptionFields({ value, onChange, supplies }: {
  value: { essences: { productId: string; grams: number | null }[]; coalProductId: string; coalUnits: number };
  onChange: (v: { essences: { productId: string; grams: number | null }[]; coalProductId: string; coalUnits: number }) => void;
  supplies: { essences: Product[]; coals: Product[]; gramsPerRosh: number };
}) {
  const total = value.essences.reduce((a, e) => a + (e.grams ?? 0), 0);
  return (
    <div className="stack">
      <div className="section-label">Essências (mistura)</div>
      {value.essences.map((e, i) => {
        const p = supplies.essences.find((x) => x.id === e.productId);
        return (
          <div key={i} className="row">
            <Select className="grow" value={e.productId} onChange={(ev) => onChange({ ...value, essences: value.essences.map((x, j) => (j === i ? { ...x, productId: ev.target.value } : x)) })}>
              <option value="">Sabor…</option>
              {supplies.essences.map((x) => <option key={x.id} value={x.id}>{x.name} ({formatQty(x.stockQty, 'mass')})</option>)}
            </Select>
            <div style={{ width: 120 }}><DecimalInput value={e.grams} onChange={(v) => onChange({ ...value, essences: value.essences.map((x, j) => (j === i ? { ...x, grams: v } : x)) })} suffix="g" /></div>
            {value.essences.length > 1 && <Button variant="plain" size="small" onClick={() => onChange({ ...value, essences: value.essences.filter((_, j) => j !== i) })}>✕</Button>}
            {p && e.grams && p.stockQty < e.grams * 1000 ? <span className="tiny danger-text">sem saldo</span> : null}
          </div>
        );
      })}
      <div className="row between">
        <Button variant="plain" size="small" icon={<Plus size={14} />} onClick={() => {
          const n = value.essences.length + 1;
          const each = Math.round((supplies.gramsPerRosh / n) * 10) / 10;
          onChange({ ...value, essences: [...value.essences.map((x) => ({ ...x, grams: each })), { productId: '', grams: each }] });
        }}>Adicionar sabor</Button>
        <span className="small muted">Total {total} g · padrão da casa {supplies.gramsPerRosh} g por rosh</span>
      </div>
      <div className="grid-2">
        <Field label="Carvão">
          <Select value={value.coalProductId} onChange={(e) => onChange({ ...value, coalProductId: e.target.value })}>
            <option value="">—</option>
            {supplies.coals.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
        <Field label="Unidades de carvão"><Input type="number" min={0} max={50} value={value.coalUnits} onChange={(e) => onChange({ ...value, coalUnits: Number(e.target.value) })} /></Field>
      </div>
    </div>
  );
}

function toPayload(v: { essences: { productId: string; grams: number | null }[]; coalProductId: string; coalUnits: number }) {
  return {
    essences: v.essences.filter((e) => e.productId && e.grams).map((e) => ({ productId: e.productId, qty: Math.round(e.grams! * 1000) })),
    coalProductId: v.coalProductId || null,
    coalUnits: v.coalProductId ? v.coalUnits : 0,
  };
}

/** Escolha da comanda: pelo número do cartão ou pela lista das abertas. */
function ComandaChooser({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const comandas = useLoad(() => api.get<ComandaSummary[]>('/api/comandas?status=open'));
  const [newComanda, setNewComanda] = useState(false);
  return (
    <Field label="Comanda do cliente" hint="O aluguel e as trocas entram nesta comanda na hora.">
      <div className="row">
        <Select className="grow" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Selecione…</option>
          {comandas.data?.map((c) => <option key={c.id} value={c.id}>{c.label} — {c.customerName || 'sem nome'}{c.table ? ` (mesa ${c.table})` : ''}</option>)}
        </Select>
        <Button onClick={() => setNewComanda(true)}>Nova</Button>
      </div>
      {newComanda && <OpenComandaModal onClose={() => setNewComanda(false)} onOpened={(id) => { void comandas.reload(); onChange(id); }} />}
    </Field>
  );
}

function RentModal({ hookah, pricing, onClose, onDone }: { hookah: Hookah | null; pricing: Pricing; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const supplies = useHookahSupplies();
  const own = hookah === null;
  const [comandaId, setComandaId] = useState('');
  const [ownLabel, setOwnLabel] = useState('');
  const [cons, setCons] = useState<{ essences: { productId: string; grams: number | null }[]; coalProductId: string; coalUnits: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);
  if (supplies.data && !cons) setCons({ essences: [{ productId: '', grams: supplies.data.gramsPerRosh }], coalProductId: supplies.data.coals[0]?.id ?? '', coalUnits: 3 });
  const price = own ? pricing.ownRoshCents : pricing.rentalCents;

  return (
    <Modal title={own ? 'Narguilé próprio do cliente' : `Alugar ${hookah.code}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!comandaId} onClick={async () => {
      setBusy(true);
      try {
        await api.post('/api/hookah-sessions', { mode: own ? 'own' : 'house', hookahId: hookah?.id ?? null, ownLabel: ownLabel || null, comandaId, clientRequestId: rid, ...toPayload(cons!) });
        toast.success(`${formatBRL(price)} lançado na comanda`); onDone(); onClose();
      } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Lançar {formatBRL(price)}</Button></>}>
      <div className="stack">
        <div className="banner">{own ? <>Cliente trouxe o narguilé: lança <strong>{formatBRL(price)}</strong> de essência + carvão a cada rosh.</> : <>Aluguel de <strong>{formatBRL(price)}</strong> com a primeira essência e o carvão inclusos.</>}</div>
        <ComandaChooser value={comandaId} onChange={setComandaId} />
        {own && <Field label="Identificação do narguilé (opcional)"><Input value={ownLabel} maxLength={40} onChange={(e) => setOwnLabel(e.target.value)} placeholder="Ex.: preto do Pedro" /></Field>}
        <div className="section-label">Consumo (para o estoque)</div>
        {supplies.data && cons ? <ConsumptionFields value={cons} onChange={setCons} supplies={supplies.data} /> : <Loading />}
      </div>
    </Modal>
  );
}

function RoshModal({ target, pricing, onClose, onDone }: { target: RentalTarget; pricing: Pricing; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const supplies = useHookahSupplies();
  const own = target.mode === 'own';
  const [charge, setCharge] = useState(true);
  const [cons, setCons] = useState<{ essences: { productId: string; grams: number | null }[]; coalProductId: string; coalUnits: number } | null>(null);
  const [rid] = useState(requestId);
  if (supplies.data && !cons) setCons({ essences: [{ productId: '', grams: supplies.data.gramsPerRosh }], coalProductId: supplies.data.coals[0]?.id ?? '', coalUnits: 2 });
  const price = target.mode === 'legacy' ? 0 : own ? pricing.ownRoshCents : pricing.roshSwapCents;
  return (
    <Modal title={`${own ? 'Novo rosh' : 'Troca de rosh'} — ${target.title}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={async () => {
      try { await api.post(`/api/hookah-sessions/${target.sessionId}/rosh`, { ...toPayload(cons!), charge, clientRequestId: rid }); toast.success(charge && price ? `${formatBRL(price)} lançado na comanda` : 'Rosh registrado'); onDone(); onClose(); } catch (e) { toast.error(e); }
    }}>{charge && price ? `Lançar ${formatBRL(price)}` : 'Registrar'}</Button></>}>
      <div className="stack">
        <div className="small muted">{target.customerName || 'Sem nome'} · comanda {target.comandaDisplayNumber}</div>
        {target.mode !== 'legacy' && (
          <Switch checked={charge} onChange={setCharge} label={`Cobrar ${own ? 'essência + carvão' : 'a troca'} (${formatBRL(price)})`} description="Desligue para troca cortesia: só baixa o estoque." />
        )}
        {supplies.data && cons ? <ConsumptionFields value={cons} onChange={setCons} supplies={supplies.data} /> : <Loading />}
      </div>
    </Modal>
  );
}

function FinishModal({ target, onClose, onDone }: { target: RentalTarget; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [cleaning, setCleaning] = useState(true);
  const own = target.mode === 'own';
  const legacy = target.mode === 'legacy';
  return (
    <Modal title={`${own ? 'Encerrar' : 'Devolução'} — ${target.title}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={async () => {
      try {
        const r = await api.post<{ chargeCents: number }>(`/api/hookah-sessions/${target.sessionId}/finish`, { sendToCleaning: cleaning });
        toast.success(legacy ? `${formatBRL(r.chargeCents)} lançado na comanda ${target.comandaDisplayNumber}` : 'Locação encerrada'); onDone(); onClose();
      } catch (e) { toast.error(e); }
    }}>{own ? 'Encerrar' : 'Confirmar devolução'}</Button></>}>
      <div className="stack">
        <div className="card tight">
          <div className="row between"><span className="muted">Cliente</span><span>{target.customerName || 'Sem nome'} · comanda {target.comandaDisplayNumber}</span></div>
          {legacy && target.legacyCharge ? (
            <>
              <div className="row between"><span className="muted">Tempo</span><span>{target.legacyCharge.minutes} min ({target.legacyCharge.periods} período(s))</span></div>
              <div className="row between"><span className="muted">Valor a lançar</span><strong className="num">{formatBRL(target.legacyCharge.totalCents)}</strong></div>
            </>
          ) : (
            <div className="row between"><span className="muted">Já lançado na comanda</span><strong className="num">{formatBRL(target.chargedCents ?? 0)}</strong></div>
          )}
        </div>
        {!own && <Switch checked={cleaning} onChange={setCleaning} label="Enviar para limpeza" />}
      </div>
    </Modal>
  );
}

function HistoryModal({ hookah, onClose }: { hookah: Hookah; onClose: () => void }) {
  const { data } = useLoad(() => api.get<{ status: { id: string; from_status: string | null; to_status: HookahStatus; notes: string | null; user_name: string | null; created_at: string }[]; sessions: { id: string; customer_name: string; started_at: string; ended_at: string | null; charge_cents: number | null; comanda_number: number }[] }>(`/api/hookahs/${hookah.id}/history`));
  return (
    <Modal title={`Histórico — ${hookah.code}`} wide onClose={onClose}>
      {!data ? <Loading /> : (
        <div className="grid-2">
          <div><div className="section-label">Locações</div><div className="list card flush">{data.sessions.map((s) => <div key={s.id} className="list-item"><div className="grow"><div>{s.customer_name}</div><div className="tiny muted">{fmtDateTime(s.started_at)} · comanda {s.comanda_number}</div></div><span className="num">{s.charge_cents !== null ? formatBRL(s.charge_cents) : 'em uso'}</span></div>)}</div></div>
          <div><div className="section-label">Status</div><div className="list card flush">{data.status.map((h) => <div key={h.id} className="list-item"><div className="grow"><div>{HOOKAH_STATUS[h.to_status]}</div><div className="tiny muted">{fmtDateTime(h.created_at)} · {h.user_name ?? 'Sistema'}{h.notes && ` · ${h.notes}`}</div></div></div>)}</div></div>
        </div>
      )}
    </Modal>
  );
}

function SessionsHistory() {
  const { can } = useSession();
  const { data, reload } = useLoad(() => api.get<SessionRow[]>('/api/hookah-sessions'));
  const [del, setDel] = useState<SessionRow | null>(null);
  if (!data) return <Loading />;
  const master = can('admin.override');
  return (
    <Card flush>
      <div className="table-wrap"><table className="table"><thead><tr><th>Início</th><th>Narguilé</th><th>Cliente</th><th>Comanda</th><th>Rosh</th><th className="right">Valor</th>{master && <th />}</tr></thead><tbody>
        {data.map((s) => (
          <tr key={s.id} className={s.status === 'canceled' ? 'voided' : ''}>
            <td className="small">{fmtDateTime(s.started_at)}</td>
            <td>{s.owner === 'customer' ? <><Badge color="purple">Próprio</Badge> {s.model}</> : s.code}</td>
            <td>{s.customer_name || '—'}</td>
            <td>{s.comanda_display_number}</td>
            <td>{s.rosh_count}</td>
            <td className="right num">{s.status === 'active' ? <Badge color="blue">Em uso · {formatBRL(s.charged_cents)}</Badge> : formatBRL(s.charge_cents ?? s.charged_cents)}</td>
            {master && <td className="right">{s.status !== 'canceled' && <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Excluir locação" title="Excluir (conta mestre)" onClick={() => setDel(s)} />}</td>}
          </tr>
        ))}
      </tbody></table></div>
      {del && (
        <ReasonModal title="Excluir locação" danger confirmLabel="Excluir locação" description="Os valores lançados por esta locação saem da comanda. O consumo de essência e carvão continua registrado no estoque."
          onClose={() => setDel(null)} onConfirm={async (reason) => { await api.post(`/api/admin/hookah-sessions/${del.id}/delete`, { reason }); void reload(); }} />
      )}
    </Card>
  );
}

function Indicators() {
  const [days, setDays] = useState(7);
  const range = dayRange(new Date(Date.now() - (days - 1) * 86_400_000), days);
  const { data } = useLoad(() => api.get<{ sessions: number; roshes: number; revenueCents: number; avgMinutes: number | null; essenceGramsMilli: number; avgGramsPerSessionMilli: number; coalUnits: number; consumptionCostCents: number; flavors: { name: string; qty: number; sessions: number }[]; devices: { code: string; sessions: number; revenue: number; minutes: number }[] }>(`/api/hookah/indicators?from=${range.from}&to=${range.to}`), [days]);
  return (
    <div className="stack">
      <Select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 200 }}>
        <option value={1}>Hoje</option><option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option>
      </Select>
      {!data ? <Loading /> : (
        <>
          <div className="grid-4">
            <Stat label="Sessões" value={data.sessions} hint={`${data.roshes} rosh no total`} />
            <Stat label="Essência consumida" value={formatQty(data.essenceGramsMilli, 'mass')} hint={`média ${formatQty(data.avgGramsPerSessionMilli, 'mass')}/sessão`} />
            <Stat label="Carvão" value={`${data.coalUnits} un`} />
            <Stat label="Receita de locação" value={formatBRL(data.revenueCents)} hint={data.avgMinutes ? `duração média ${data.avgMinutes} min` : undefined} />
          </div>
          <div className="grid-2">
            <Card title="Sabores mais usados" flush><div className="list">{data.flavors.length === 0 && <div className="list-item muted">Sem dados.</div>}{data.flavors.map((f) => <div key={f.name} className="list-item"><span className="grow">{f.name}</span><span className="small muted">{f.sessions} sessões</span><span className="num strong">{formatQty(f.qty, 'mass')}</span></div>)}</div></Card>
            <Card title="Uso por aparelho" flush><div className="list">{data.devices.map((d) => <div key={d.code} className="list-item"><span className="grow">{d.code}</span><span className="small muted">{d.sessions} sessões · {Math.round(d.minutes)} min</span><span className="num">{formatBRL(d.revenue)}</span></div>)}</div></Card>
          </div>
        </>
      )}
    </div>
  );
}
