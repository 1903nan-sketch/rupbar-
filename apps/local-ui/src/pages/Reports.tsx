import { PAYMENT_METHODS, type PaymentMethod } from '@rupbar/core';
import { BarChart3 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Stat, Tabs } from '../components/ui';
import { api, qs } from '../lib/api';
import { dayRange, fmtDateTime, formatBRL, formatQty, fromInputDate, toInputDate } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Product } from './Products';

type Tab = 'vendas' | 'produtos' | 'operacional' | 'perdas' | 'caixas' | 'auditoria';

export function ReportsPage() {
  const { can } = useSession();
  const fin = can('reports.financial');
  const [tab, setTab] = useState<Tab>(fin ? 'vendas' : 'operacional');
  const [from, setFrom] = useState(toInputDate(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(toInputDate(new Date()));
  const start = dayRange(fromInputDate(from)).from;
  const end = dayRange(fromInputDate(to)).to;
  return (
    <div className="stack">
      <PageHeader title="Relatórios" actions={
        <div className="row">
          <Field label="De"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Até"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      } />
      <Tabs value={tab} onChange={setTab} options={[
        { value: 'vendas', label: 'Vendas', hidden: !fin },
        { value: 'produtos', label: 'Comparar produtos', hidden: !fin },
        { value: 'operacional', label: 'Operacional' },
        { value: 'perdas', label: 'Perdas', hidden: !can('losses.view') },
        { value: 'caixas', label: 'Caixas', hidden: !fin },
        { value: 'auditoria', label: 'Auditoria', hidden: !can('audit.view') },
      ]} />
      {tab === 'vendas' && <Sales from={start} to={end} />}
      {tab === 'produtos' && <Compare from={start} to={end} />}
      {tab === 'operacional' && <Operational from={start} to={end} />}
      {tab === 'perdas' && <LossesReport from={start} to={end} />}
      {tab === 'caixas' && <CashSessions />}
      {tab === 'auditoria' && <Audit />}
    </div>
  );
}

function Bars({ rows, label, value }: { rows: Record<string, any>[]; label: string; value: string }) {
  const max = Math.max(1, ...rows.map((r) => Number(r[value]) || 0));
  return (
    <div className="col" style={{ gap: 10 }}>
      {rows.map((r, i) => (
        <div key={i}>
          <div className="row between small"><span className="ellipsis">{r[label]}</span><span className="num strong">{formatBRL(Number(r[value]))}</span></div>
          <div className="progress"><span style={{ width: `${(Number(r[value]) / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function Sales({ from, to }: { from: string; to: string }) {
  const { data, error } = useLoad(() => api.get(`/api/reports/sales${qs({ from, to })}`), [from, to]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const margin = data.grossCents ? Math.round((data.marginCents / data.grossCents) * 100) : 0;
  return (
    <div className="stack">
      <div className="grid-4">
        <Stat label="Faturamento" value={formatBRL(data.grossCents)} hint={`${data.itemsSold} itens`} />
        <Stat label="Custo estimado" value={formatBRL(data.costCents)} />
        <Stat label="Margem bruta" value={formatBRL(data.marginCents)} hint={`${margin}%`} />
        <Stat label="Descontos" value={formatBRL(data.discountsCents)} />
      </div>
      <div className="grid-2">
        <Card title="Por dia">
          {data.byDay.length ? <Bars rows={data.byDay} label="day" value="total" /> : <Empty title="Sem vendas" />}
        </Card>
        <Card title="Por forma de pagamento">
          {data.payments.length ? <Bars rows={data.payments.map((p: { method: PaymentMethod; total: number }) => ({ ...p, label: PAYMENT_METHODS[p.method] ?? p.method }))} label="label" value="total" /> : <Empty title="Sem pagamentos" />}
        </Card>
        <Card title="Por categoria">
          {data.byCategory.length ? <Bars rows={data.byCategory} label="category" value="total" /> : <Empty title="Sem vendas" />}
        </Card>
        <Card title="Por atendente">
          {data.byWaiter.length ? <Bars rows={data.byWaiter} label="name" value="total" /> : <Empty title="Sem pedidos" />}
        </Card>
      </div>
      <Card title="Produtos mais vendidos" flush>
        <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th className="right">Qtd.</th><th className="right">Faturamento</th><th className="right">Custo</th><th className="right">Margem</th></tr></thead><tbody>
          {data.topProducts.map((p: { product_id: string; product_name: string; presentation_name: string; qty: number; total: number; cost: number }) => (
            <tr key={`${p.product_id}-${p.presentation_name}`}><td>{p.product_name} <span className="muted">· {p.presentation_name}</span></td><td className="right num">{p.qty}</td><td className="right num">{formatBRL(p.total)}</td><td className="right num muted">{formatBRL(p.cost)}</td><td className="right num">{p.total ? Math.round(((p.total - p.cost) / p.total) * 100) : 0}%</td></tr>
          ))}
        </tbody></table></div>
      </Card>
      {data.cancellations.length > 0 && (
        <Card title="Cancelamentos" flush>
          <div className="list">{data.cancellations.map((c: { product_name: string; quantity: number; unit_price_cents: number; cancel_reason: string; canceled_at: string; canceled_by_name: string }, i: number) => (
            <div key={i} className="list-item"><div className="grow"><div>{c.quantity}× {c.product_name}</div><div className="tiny muted">{fmtDateTime(c.canceled_at)} · {c.canceled_by_name} · {c.cancel_reason}</div></div><span className="num">{formatBRL(c.quantity * c.unit_price_cents)}</span></div>
          ))}</div>
        </Card>
      )}
    </div>
  );
}

function Compare({ from, to }: { from: string; to: string }) {
  const products = useLoad(() => api.get<Product[]>('/api/products'));
  const [selected, setSelected] = useState<string[]>([]);
  const { data } = useLoad(() => (selected.length ? api.post('/api/reports/compare', { from, to, productIds: selected }) : Promise.resolve(null)), [from, to, selected.join(',')]);
  return (
    <div className="stack">
      <Card title="Selecione até 8 produtos">
        <div className="row wrap">
          {products.data?.filter((p) => p.presentations.length).map((p) => (
            <button key={p.id} type="button" className={`chip ${selected.includes(p.id) ? 'active' : ''}`} onClick={() => setSelected(selected.includes(p.id) ? selected.filter((x) => x !== p.id) : selected.length < 8 ? [...selected, p.id] : selected)}>{p.name}</button>
          ))}
        </div>
      </Card>
      {data && (
        <Card flush>
          <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th className="right">Qtd.</th><th className="right">Faturamento</th><th className="right">Custo</th><th className="right">Margem</th><th className="right">Perdas</th></tr></thead><tbody>
            {data.summary.map((p: { product_id: string; name: string; qty: number; total: number; cost: number; loss_cost: number }) => (
              <tr key={p.product_id}><td className="strong">{p.name}</td><td className="right num">{p.qty}</td><td className="right num">{formatBRL(p.total)}</td><td className="right num">{formatBRL(p.cost)}</td><td className="right num">{formatBRL(p.total - p.cost)}{p.total ? ` (${Math.round(((p.total - p.cost) / p.total) * 100)}%)` : ''}</td><td className="right num danger-text">{p.loss_cost ? formatBRL(p.loss_cost) : '—'}</td></tr>
            ))}
          </tbody></table></div>
        </Card>
      )}
    </div>
  );
}

function Operational({ from, to }: { from: string; to: string }) {
  const { data, error } = useLoad(() => api.get(`/api/reports/operational${qs({ from, to })}`), [from, to]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const maxH = Math.max(1, ...data.ordersByHour.map((h: { orders: number }) => h.orders));
  return (
    <div className="stack">
      <div className="grid-2">
        <Card title="Pedidos por hora">
          <div className="bar-chart">{Array.from({ length: 24 }, (_, h) => { const v = data.ordersByHour.find((x: { hour: number }) => x.hour === h)?.orders ?? 0; return <div key={h} className="bar" style={{ height: `${(v / maxH) * 100}%`, opacity: v ? 0.85 : 0.15 }} title={`${h}h: ${v}`} />; })}</div>
        </Card>
        <Card title="Tempo de preparo">
          <div className="list">{data.prep.length === 0 && <div className="muted">Sem dados.</div>}{data.prep.map((p: { station: string; tickets: number; avg_minutes: number; max_minutes: number }) => (
            <div key={p.station} className="list-item"><span className="grow">{p.station === 'kitchen' ? 'Cozinha' : 'Bebidas'}</span><span className="small muted">{p.tickets} pedidos</span><span className="strong">{Math.round(p.avg_minutes)} min (máx. {Math.round(p.max_minutes)})</span></div>
          ))}</div>
        </Card>
      </div>
      <Card title="Itens vendidos" flush>
        <div className="list">{data.items.map((i: { product_name: string; presentation_name: string; qty: number }, k: number) => <div key={k} className="list-item"><span className="grow">{i.product_name} <span className="muted">· {i.presentation_name}</span></span><span className="num strong">{i.qty}</span></div>)}</div>
      </Card>
    </div>
  );
}

function LossesReport({ from, to }: { from: string; to: string }) {
  const { data, error } = useLoad(() => api.get(`/api/reports/losses${qs({ from, to })}`), [from, to]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      {data.totalCostCents !== null && <Stat label="Custo estimado das perdas" value={formatBRL(data.totalCostCents)} />}
      <div className="grid-2">
        <Card title="Por motivo" flush><div className="list">{data.byReason.map((r: { reason: string; label: string; count: number; cost_cents: number | null }) => <div key={r.reason} className="list-item"><span className="grow">{r.label}</span><Badge>{r.count}</Badge>{r.cost_cents !== null && <span className="num">{formatBRL(r.cost_cents)}</span>}</div>)}</div></Card>
        <Card title="Por categoria" flush><div className="list">{data.byCategory.map((r: { category: string; count: number; cost_cents: number | null }) => <div key={r.category} className="list-item"><span className="grow">{r.category}</span><Badge>{r.count}</Badge>{r.cost_cents !== null && <span className="num">{formatBRL(r.cost_cents)}</span>}</div>)}</div></Card>
      </div>
      <Card title="Por produto" flush>
        <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th>Categoria</th><th className="right">Ocorrências</th><th className="right">Quantidade</th><th className="right">Custo</th></tr></thead><tbody>
          {data.byProduct.map((r: { product_id: string; name: string; category: string; count: number; qty: number; measure: 'unit'; cost_cents: number | null }) => (
            <tr key={r.product_id}><td>{r.name}</td><td className="muted">{r.category}</td><td className="right">{r.count}</td><td className="right num">{formatQty(r.qty, r.measure)}</td><td className="right num">{r.cost_cents !== null ? formatBRL(r.cost_cents) : '—'}</td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  );
}

function CashSessions() {
  const { data, error } = useLoad(() => api.get('/api/cash/sessions'));
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.length) return <Card><Empty icon={<BarChart3 size={36} />} title="Nenhum caixa registrado" /></Card>;
  return (
    <Card flush>
      <div className="table-wrap"><table className="table"><thead><tr><th>Caixa</th><th>Abertura</th><th>Fechamento</th><th className="right">Esperado</th><th className="right">Contado</th><th className="right">Diferença</th></tr></thead><tbody>
        {data.map((s: { id: string; number: number; status: string; openedAt: string; openedByName: string; closedAt: string | null; closedByName: string | null; expectedCashCents: number | null; countedCashCents: number | null; differenceCents: number | null }) => (
          <tr key={s.id}>
            <td className="strong">nº {s.number}</td>
            <td className="small">{fmtDateTime(s.openedAt)}<div className="tiny muted">{s.openedByName}</div></td>
            <td className="small">{s.status === 'open' ? <Badge color="green">Aberto</Badge> : <>{fmtDateTime(s.closedAt)}<div className="tiny muted">{s.closedByName}</div></>}</td>
            <td className="right num">{s.expectedCashCents !== null ? formatBRL(s.expectedCashCents) : '—'}</td>
            <td className="right num">{s.countedCashCents !== null ? formatBRL(s.countedCashCents) : '—'}</td>
            <td className={`right num strong ${s.differenceCents && s.differenceCents < 0 ? 'danger-text' : s.differenceCents ? 'warning-text' : ''}`}>{s.differenceCents !== null ? formatBRL(s.differenceCents) : '—'}</td>
          </tr>
        ))}
      </tbody></table></div>
    </Card>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const { data } = useLoad(() => api.get(`/api/audit${qs({ action })}`), [action]);
  return (
    <div className="stack">
      <Input placeholder="Filtrar por ação (ex.: cash, comandas.item_canceled, users)" value={action} onChange={(e) => setAction(e.target.value)} style={{ maxWidth: 420 }} />
      {!data ? <Loading /> : (
        <Card flush>
          <div className="table-wrap"><table className="table"><thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>
            {data.map((a: { id: string; created_at: string; user_name: string; action: string; data_json: string | null; ip: string | null }) => (
              <tr key={a.id}><td className="small nowrap">{fmtDateTime(a.created_at)}</td><td className="small">{a.user_name}{a.ip && <div className="tiny muted">{a.ip}</div>}</td><td><span className="kbd">{a.action}</span></td><td className="tiny muted mono" style={{ maxWidth: 520, wordBreak: 'break-word' }}>{a.data_json}</td></tr>
            ))}
          </tbody></table></div>
        </Card>
      )}
    </div>
  );
}
