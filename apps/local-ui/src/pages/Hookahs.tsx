import { HOOKAH_STATUS, type HookahStatus } from '@rupbar/core';
import { History, Plus, RotateCcw, Sparkles, Timer, Wind, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Switch, Tabs, useToast } from '../components/ui';
import { api, requestId } from '../lib/api';
import { dayRange, elapsed, fmtDateTime, formatBRL, formatQty } from '../lib/format';
import { useLoad, useNow } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import type { ComandaSummary } from './Comandas';
import { OpenComandaModal } from './Comandas';
import type { Product } from './Products';

interface Hookah {
  id: string;
  code: string;
  model: string;
  pricingMode: 'fixed' | 'per_period';
  priceCents: number;
  periodMinutes: number;
  toleranceMinutes: number;
  status: HookahStatus;
  statusLabel: string;
  notes: string | null;
  active: boolean;
  session: null | { id: string; startedAt: string; customerName: string; roshCount: number; comandaNumber: number; table: string | null; currentCharge: { totalCents: number; minutes: number; periods: number } };
}

const STATUS_COLOR: Record<HookahStatus, 'green' | 'orange' | 'blue' | 'red' | undefined> = {
  available: 'green', rented: 'blue', cleaning: 'orange', maintenance: 'red', inactive: undefined,
};

export function HookahsPage() {
  const [tab, setTab] = useState<'aparelhos' | 'historico' | 'indicadores'>('aparelhos');
  const { can } = useSession();
  return (
    <div className="stack">
      <PageHeader title="Narguilés" subtitle="Locação de aparelhos, consumo de essências (g) e carvão." />
      <Tabs value={tab} onChange={setTab} options={[{ value: 'aparelhos', label: 'Aparelhos' }, { value: 'historico', label: 'Locações' }, { value: 'indicadores', label: 'Indicadores', hidden: !can('reports.operational') }]} />
      {tab === 'aparelhos' && <Devices />}
      {tab === 'historico' && <SessionsHistory />}
      {tab === 'indicadores' && <Indicators />}
    </div>
  );
}

function Devices() {
  const { can } = useSession();
  const toast = useToast();
  const now = useNow(30_000);
  const { data, error, reload } = useLoad(() => api.get<Hookah[]>('/api/hookahs'));
  useRealtime(['hookah', 'comandas'], () => void reload());
  const [edit, setEdit] = useState<Hookah | 'new' | null>(null);
  const [rent, setRent] = useState<Hookah | null>(null);
  const [rosh, setRosh] = useState<Hookah | null>(null);
  const [finish, setFinish] = useState<Hookah | null>(null);
  const [history, setHistory] = useState<Hookah | null>(null);

  const setStatus = async (h: Hookah, status: HookahStatus) => {
    try {
      await api.post(`/api/hookahs/${h.id}/status`, { status });
      void reload();
    } catch (e) {
      toast.error(e);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      {can('hookah.manage') && <Button variant="primary" icon={<Plus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setEdit('new')}>Cadastrar aparelho</Button>}
      {data.length === 0 ? <Card><Empty icon={<Wind size={40} />} title="Nenhum narguilé cadastrado" /></Card> : (
        <div className="grid-auto">
          {data.map((h) => (
            <Card key={h.id}>
              <div className="row between">
                <span className="strong" style={{ fontSize: 22 }}>{h.code}</span>
                <Badge color={STATUS_COLOR[h.status]}>{h.statusLabel}</Badge>
              </div>
              <div className="small muted">{h.model || 'Modelo não informado'} · {h.pricingMode === 'fixed' ? `${formatBRL(h.priceCents)} fixo` : `${formatBRL(h.priceCents)} / ${h.periodMinutes} min`}</div>
              {h.session && (
                <div className="card tight" style={{ marginTop: 12, background: 'var(--accent-soft)', border: 0 }}>
                  <div className="strong">{h.session.customerName}</div>
                  <div className="small muted">Comanda #{h.session.comandaNumber}{h.session.table && ` · Mesa ${h.session.table}`}</div>
                  <div className="row between small" style={{ marginTop: 6 }}>
                    <span className="row"><Timer size={14} /> {elapsed(h.session.startedAt, now)} · {h.session.roshCount} rosh</span>
                    <span className="num strong">{formatBRL(h.session.currentCharge.totalCents)}</span>
                  </div>
                </div>
              )}
              <div className="row wrap" style={{ marginTop: 14, gap: 6 }}>
                {h.status === 'available' && can('hookah.rent') && <Button size="small" variant="primary" onClick={() => setRent(h)}>Nova locação</Button>}
                {h.status === 'rented' && can('hookah.rent') && (
                  <>
                    <Button size="small" icon={<Plus size={14} />} onClick={() => setRosh(h)}>Rosh</Button>
                    <Button size="small" variant="primary" icon={<RotateCcw size={14} />} onClick={() => setFinish(h)}>Devolução</Button>
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
      {rent && <RentModal hookah={rent} onClose={() => setRent(null)} onDone={reload} />}
      {rosh && <RoshModal hookah={rosh} onClose={() => setRosh(null)} onDone={reload} />}
      {finish && <FinishModal hookah={finish} onClose={() => setFinish(null)} onDone={reload} />}
      {history && <HistoryModal hookah={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function HookahEditor({ hookah, onClose, onDone }: { hookah: Hookah | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    code: hookah?.code ?? '', model: hookah?.model ?? '', pricingMode: hookah?.pricingMode ?? ('fixed' as Hookah['pricingMode']),
    priceCents: hookah?.priceCents ?? (null as number | null), periodMinutes: hookah?.periodMinutes ?? 60, toleranceMinutes: hookah?.toleranceMinutes ?? 10,
    notes: hookah?.notes ?? '', active: hookah?.active ?? true,
  });
  return (
    <Modal title={hookah ? `Narguilé ${hookah.code}` : 'Novo narguilé'} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={async () => {
      try {
        const body = { ...f, priceCents: f.priceCents ?? 0, notes: f.notes || null };
        if (hookah) await api.put(`/api/hookahs/${hookah.id}`, body); else await api.post('/api/hookahs', body);
        toast.success('Aparelho salvo'); onDone(); onClose();
      } catch (e) { toast.error(e); }
    }}>Salvar</Button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Identificador *"><Input autoFocus value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="N-01" /></Field>
          <Field label="Modelo"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        </div>
        <Field label="Cobrança">
          <Select value={f.pricingMode} onChange={(e) => setF({ ...f, pricingMode: e.target.value as Hookah['pricingMode'] })}>
            <option value="fixed">Valor fixo por locação</option>
            <option value="per_period">Por período</option>
          </Select>
        </Field>
        <div className="grid-3">
          <Field label={f.pricingMode === 'fixed' ? 'Valor' : 'Valor por período'}><MoneyInput value={f.priceCents} onChange={(v) => setF({ ...f, priceCents: v })} /></Field>
          {f.pricingMode === 'per_period' && <Field label="Período (min)"><Input type="number" min={5} value={f.periodMinutes} onChange={(e) => setF({ ...f, periodMinutes: Number(e.target.value) })} /></Field>}
          {f.pricingMode === 'per_period' && <Field label="Tolerância (min)"><Input type="number" min={0} value={f.toleranceMinutes} onChange={(e) => setF({ ...f, toleranceMinutes: Number(e.target.value) })} /></Field>}
        </div>
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

function RentModal({ hookah, onClose, onDone }: { hookah: Hookah; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const supplies = useHookahSupplies();
  const comandas = useLoad(() => api.get<ComandaSummary[]>('/api/comandas?status=open'));
  const [comandaId, setComandaId] = useState('');
  const [newComanda, setNewComanda] = useState(false);
  const [cons, setCons] = useState<{ essences: { productId: string; grams: number | null }[]; coalProductId: string; coalUnits: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);
  if (supplies.data && !cons) setCons({ essences: [{ productId: '', grams: supplies.data.gramsPerRosh }], coalProductId: supplies.data.coals[0]?.id ?? '', coalUnits: 3 });

  return (
    <Modal title={`Locação — ${hookah.code}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!comandaId} onClick={async () => {
      setBusy(true);
      try {
        await api.post('/api/hookah-sessions', { hookahId: hookah.id, comandaId, clientRequestId: rid, ...toPayload(cons!) });
        toast.success('Locação iniciada'); onDone(); onClose();
      } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Iniciar locação</Button></>}>
      <div className="stack">
        <Field label="Comanda do cliente" hint="O valor da locação e o consumo ficam vinculados à comanda.">
          <div className="row">
            <Select className="grow" value={comandaId} onChange={(e) => setComandaId(e.target.value)}>
              <option value="">Selecione…</option>
              {comandas.data?.map((c) => <option key={c.id} value={c.id}>#{c.number} — {c.customerName}{c.table ? ` (mesa ${c.table})` : ''}</option>)}
            </Select>
            <Button onClick={() => setNewComanda(true)}>Nova</Button>
          </div>
        </Field>
        {supplies.data && cons ? <ConsumptionFields value={cons} onChange={setCons} supplies={supplies.data} /> : <Loading />}
      </div>
      {newComanda && <OpenComandaModal onClose={() => setNewComanda(false)} onOpened={(id) => { void comandas.reload(); setComandaId(id); }} />}
    </Modal>
  );
}

function RoshModal({ hookah, onClose, onDone }: { hookah: Hookah; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const supplies = useHookahSupplies();
  const [cons, setCons] = useState<{ essences: { productId: string; grams: number | null }[]; coalProductId: string; coalUnits: number } | null>(null);
  if (supplies.data && !cons) setCons({ essences: [{ productId: '', grams: supplies.data.gramsPerRosh }], coalProductId: supplies.data.coals[0]?.id ?? '', coalUnits: 2 });
  return (
    <Modal title={`Novo rosh — ${hookah.code}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={async () => {
      try { await api.post(`/api/hookah-sessions/${hookah.session!.id}/rosh`, toPayload(cons!)); toast.success('Rosh registrado'); onDone(); onClose(); } catch (e) { toast.error(e); }
    }}>Registrar</Button></>}>
      {supplies.data && cons ? <ConsumptionFields value={cons} onChange={setCons} supplies={supplies.data} /> : <Loading />}
    </Modal>
  );
}

function FinishModal({ hookah, onClose, onDone }: { hookah: Hookah; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [cleaning, setCleaning] = useState(true);
  const s = hookah.session!;
  return (
    <Modal title={`Devolução — ${hookah.code}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={async () => {
      try {
        const r = await api.post<{ chargeCents: number }>(`/api/hookah-sessions/${s.id}/finish`, { sendToCleaning: cleaning });
        toast.success(`${formatBRL(r.chargeCents)} lançado na comanda #${s.comandaNumber}`); onDone(); onClose();
      } catch (e) { toast.error(e); }
    }}>Confirmar devolução</Button></>}>
      <div className="stack">
        <div className="card tight">
          <div className="row between"><span className="muted">Cliente</span><span>{s.customerName} · comanda #{s.comandaNumber}</span></div>
          <div className="row between"><span className="muted">Tempo</span><span>{s.currentCharge.minutes} min ({s.currentCharge.periods} período(s))</span></div>
          <div className="row between"><span className="muted">Valor a lançar</span><strong className="num">{formatBRL(s.currentCharge.totalCents)}</strong></div>
        </div>
        <Switch checked={cleaning} onChange={setCleaning} label="Enviar para limpeza" />
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
          <div><div className="section-label">Locações</div><div className="list card flush">{data.sessions.map((s) => <div key={s.id} className="list-item"><div className="grow"><div>{s.customer_name}</div><div className="tiny muted">{fmtDateTime(s.started_at)} · #{s.comanda_number}</div></div><span className="num">{s.charge_cents !== null ? formatBRL(s.charge_cents) : 'em uso'}</span></div>)}</div></div>
          <div><div className="section-label">Status</div><div className="list card flush">{data.status.map((h) => <div key={h.id} className="list-item"><div className="grow"><div>{HOOKAH_STATUS[h.to_status]}</div><div className="tiny muted">{fmtDateTime(h.created_at)} · {h.user_name ?? 'Sistema'}{h.notes && ` · ${h.notes}`}</div></div></div>)}</div></div>
        </div>
      )}
    </Modal>
  );
}

function SessionsHistory() {
  const { data } = useLoad(() => api.get<{ id: string; customer_name: string; started_at: string; ended_at: string | null; status: string; charge_cents: number | null; rosh_count: number; code: string; comanda_number: number }[]>('/api/hookah-sessions'));
  if (!data) return <Loading />;
  return (
    <Card flush>
      <div className="table-wrap"><table className="table"><thead><tr><th>Início</th><th>Aparelho</th><th>Cliente</th><th>Comanda</th><th>Rosh</th><th className="right">Valor</th></tr></thead><tbody>
        {data.map((s) => <tr key={s.id}><td className="small">{fmtDateTime(s.started_at)}</td><td>{s.code}</td><td>{s.customer_name}</td><td>#{s.comanda_number}</td><td>{s.rosh_count}</td><td className="right num">{s.charge_cents !== null ? formatBRL(s.charge_cents) : <Badge color="blue">Em uso</Badge>}</td></tr>)}
      </tbody></table></div>
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
