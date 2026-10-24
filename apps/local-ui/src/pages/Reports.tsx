import { addDays, barDay, paymentLabel, reportFileName, reportTitle, reportTotals, reportWindow, reportWindowLabel, type FullReport } from '@rupbar/core';
import { BarChart3, ChevronLeft, ChevronRight, FileDown, Printer } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Segmented, Stat, Tabs, useToast } from '../components/ui';
import { api, qs } from '../lib/api';
import { fmtDateTime, formatBRL, formatQty } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Product } from './Products';

type Tab = 'vendas' | 'produtos' | 'operacional' | 'perdas' | 'caixas' | 'auditoria';
type Mode = 'dia' | 'periodo';

export function ReportsPage() {
  const { can } = useSession();
  const fin = can('reports.financial');
  const [tab, setTab] = useState<Tab>(fin ? 'vendas' : 'operacional');
  const today = barDay();
  const [mode, setMode] = useState<Mode>('dia');
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const de = mode === 'dia' ? day : from <= to ? from : to;
  const ate = mode === 'dia' ? day : from <= to ? to : from;
  // O dia do bar vai das 05:00 às 05:00 do dia seguinte.
  const w = reportWindow(de, ate);
  return (
    <div className="stack">
      <PageHeader title="Relatórios" subtitle={`${reportTitle(de, ate)} · ${reportWindowLabel(de, ate)}`} />
      <div className="card tight report-period">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'dia', label: 'Um dia' }, { value: 'periodo', label: 'Período' }]} />
        {mode === 'dia' ? (
          <div className="row wrap" style={{ gap: 8 }}>
            <Button variant="plain" icon={<ChevronLeft size={18} />} aria-label="Dia anterior" onClick={() => setDay(addDays(day, -1))} />
            <Input type="date" aria-label="Dia" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ width: 170 }} />
            <Button variant="plain" icon={<ChevronRight size={18} />} aria-label="Próximo dia" disabled={day >= today} onClick={() => setDay(addDays(day, 1))} />
            <button type="button" className={`chip ${day === today ? 'active' : ''}`} onClick={() => setDay(today)}>Hoje</button>
            <button type="button" className={`chip ${day === addDays(today, -1) ? 'active' : ''}`} onClick={() => setDay(addDays(today, -1))}>Ontem</button>
          </div>
        ) : (
          <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label="De"><Input type="date" value={from} max={today} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
            <Field label="Até"><Input type="date" value={to} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
            {[7, 15, 30].map((n) => (
              <button key={n} type="button" className={`chip ${from === addDays(today, -(n - 1)) && to === today ? 'active' : ''}`} onClick={() => { setFrom(addDays(today, -(n - 1))); setTo(today); }}>{n} dias</button>
            ))}
            <button type="button" className="chip" onClick={() => { setFrom(`${today.slice(0, 8)}01`); setTo(today); }}>Este mês</button>
          </div>
        )}
      </div>
      <Tabs value={tab} onChange={setTab} options={[
        { value: 'vendas', label: mode === 'dia' ? 'Venda do dia' : 'Vendas', hidden: !fin },
        { value: 'produtos', label: 'Comparar produtos', hidden: !fin },
        { value: 'operacional', label: 'Operacional' },
        { value: 'perdas', label: 'Perdas', hidden: !can('losses.view') },
        { value: 'caixas', label: 'Caixas', hidden: !fin },
        { value: 'auditoria', label: 'Auditoria', hidden: !can('audit.view') },
      ]} />
      {tab === 'vendas' && <FullReportView de={de} ate={ate} />}
      {tab === 'produtos' && <Compare from={w.from} to={w.to} />}
      {tab === 'operacional' && <Operational from={w.from} to={w.to} />}
      {tab === 'perdas' && <LossesReport from={w.from} to={w.to} />}
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

const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '—');
const productLabel = (p: { name: string; presentation: string }) =>
  p.presentation && p.presentation !== 'Unidade' && p.presentation.toLowerCase() !== p.name.toLowerCase() ? `${p.name} · ${p.presentation}` : p.name;

/** Tudo do dia (ou do período): resumo, recebimentos, produtos, descontos, cancelamentos, caixa. Imprime e salva em PDF. */
function FullReportView({ de, ate }: { de: string; ate: string }) {
  const toast = useToast();
  const [printing, setPrinting] = useState(false);
  const { data: r, error, reload } = useLoad(() => api.get<FullReport>(`/api/reports/full${qs({ de, ate })}`), [de, ate]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!r) return <Loading />;
  const s = r.summary;
  const t = reportTotals(r);
  const print = async () => {
    setPrinting(true);
    try {
      await api.post('/api/reports/full/print', { de, ate });
      toast.success('Enviado para a impressora do caixa');
    } catch (e) {
      toast.error(e);
    } finally {
      setPrinting(false);
    }
  };
  const hours = de === ate ? r.byHour.map((h) => ({ label: `${String(h.hour).padStart(2, '0')}h`, total: h.totalCents })) : r.byDay.map((d) => ({ label: reportTitle(d.day, d.day).replace('-feira', ''), total: d.totalCents }));
  const facts = [
    s.canceledCents ? `Cancelados: ${formatBRL(s.canceledCents)}` : null,
    s.reversedCents ? `Estornos: ${formatBRL(s.reversedCents)}` : null,
    s.canceledComandas ? `Comandas canceladas: ${s.canceledComandas}` : null,
    s.staffCents ? `Consumo de funcionários: ${formatBRL(s.staffCents)}` : null,
    s.lossesCents ? `Perdas: ${formatBRL(s.lossesCents)}` : null,
    r.hookah.sessions ? `Narguilés: ${r.hookah.sessions} (${formatBRL(r.hookah.totalCents)})` : null,
    s.stillOpen ? `Ainda abertas: ${s.stillOpen} (${formatBRL(s.stillOpenCents)})` : null,
  ].filter(Boolean);
  return (
    <div className="stack">
      <div className="row wrap report-actions">
        <Button variant="primary" icon={<Printer size={16} />} loading={printing} onClick={() => void print()}>Imprimir no caixa</Button>
        <a className="btn" href={`/api/reports/full.pdf${qs({ de, ate })}`} download={reportFileName(de, ate)}><FileDown size={16} /> Salvar PDF</a>
        <span className="small muted">{reportWindowLabel(de, ate)}</span>
      </div>
      <div className="grid-4">
        <Stat label="Vendido (itens)" value={formatBRL(s.grossCents)} hint={`${s.itemsSold} itens`} />
        <Stat label="Descontos" value={<span className={s.discountsCents ? 'warning-text' : ''}>{s.discountsCents ? `− ${formatBRL(s.discountsCents)}` : formatBRL(0)}</span>} hint={s.serviceFeeCents ? `taxa de serviço + ${formatBRL(s.serviceFeeCents)}` : `${r.discounts.length} comanda(s)`} />
        <Stat label="Líquido" value={formatBRL(t.netCents)} hint="vendido − descontos + taxa" />
        <Stat label="Recebido" value={formatBRL(s.receivedCents)} hint="pagamentos no período" />
        <Stat label="Custo estimado" value={formatBRL(s.costCents)} />
        <Stat label="Lucro bruto" value={formatBRL(t.marginCents)} hint={`margem ${t.marginPct}%`} />
        <Stat label="Atendimentos" value={t.tickets} hint={`${s.closedComandas} comandas · ${s.quickSales} vendas rápidas`} />
        <Stat label="Ticket médio" value={formatBRL(t.averageTicketCents)} />
      </div>
      {facts.length > 0 && <p className="small muted" style={{ margin: 0 }}>{facts.join('   ·   ')}</p>}
      <div className="grid-2">
        <Card title="Recebimentos por forma de pagamento" flush>
          {r.payments.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>Forma</th><th className="right">Pagamentos</th><th className="right">%</th><th className="right">Valor</th></tr></thead><tbody>
              {r.payments.map((p) => <tr key={p.method}><td>{paymentLabel(p.method)}</td><td className="right num">{p.count}</td><td className="right num muted">{pct(p.totalCents, s.receivedCents)}</td><td className="right num strong">{formatBRL(p.totalCents)}</td></tr>)}
              <tr className="total-row"><td>Total</td><td className="right num">{r.payments.reduce((a, p) => a + p.count, 0)}</td><td /><td className="right num">{formatBRL(s.receivedCents)}</td></tr>
            </tbody></table></div>
          ) : <Empty title="Nenhum pagamento" />}
        </Card>
        <Card title={de === ate ? 'Vendas por hora' : 'Vendas por dia'}>
          {hours.length ? <Bars rows={hours} label="label" value="total" /> : <Empty title="Sem vendas" />}
        </Card>
        <Card title="Por categoria">
          {r.byCategory.length ? <Bars rows={r.byCategory} label="category" value="totalCents" /> : <Empty title="Sem vendas" />}
        </Card>
        <Card title="Por atendente">
          {r.byWaiter.length ? <Bars rows={r.byWaiter.map((w) => ({ ...w, label: `${w.name} · ${w.orders} pedido(s)` }))} label="label" value="totalCents" /> : <Empty title="Sem pedidos" />}
        </Card>
      </div>
      <Card title={`Produtos vendidos · ${r.products.length}`} flush>
        {r.products.length ? (
          <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th className="right">Qtd.</th><th className="right">Custo</th><th className="right">Margem</th><th className="right">Vendido</th></tr></thead><tbody>
            {r.products.map((p, i) => <tr key={i}><td>{productLabel(p)}</td><td className="right num">{p.qty}</td><td className="right num muted">{formatBRL(p.costCents)}</td><td className="right num">{pct(p.totalCents - p.costCents, p.totalCents)}</td><td className="right num strong">{formatBRL(p.totalCents)}</td></tr>)}
            <tr className="total-row"><td>Total</td><td className="right num">{s.itemsSold}</td><td className="right num">{formatBRL(s.costCents)}</td><td className="right num">{t.marginPct}%</td><td className="right num">{formatBRL(s.grossCents)}</td></tr>
          </tbody></table></div>
        ) : <Empty title="Nenhum produto vendido" />}
      </Card>
      <Card title={`Descontos · ${formatBRL(s.discountsCents)}`} flush>
        {r.discounts.length ? (
          <div className="table-wrap"><table className="table"><thead><tr><th>Comanda</th><th>Cliente</th><th>Motivo</th><th>Encerrada</th><th className="right">Desconto</th></tr></thead><tbody>
            {r.discounts.map((d, i) => <tr key={i}><td className="strong">{d.comanda}</td><td>{d.customer ?? '—'}</td><td>{d.reason ?? '—'}</td><td className="small">{d.closedAt ? fmtDateTime(d.closedAt) : '—'}{d.closedBy && <div className="tiny muted">{d.closedBy}</div>}</td><td className="right num warning-text">− {formatBRL(d.discountCents)}</td></tr>)}
          </tbody></table></div>
        ) : <Empty title="Nenhum desconto" />}
      </Card>
      <Card title={`Cancelamentos · ${formatBRL(s.canceledCents)}`} flush>
        {r.cancellations.length ? (
          <div className="list">{r.cancellations.map((c, i) => (
            <div key={i} className="list-item"><div className="grow"><div>{c.qty}× {c.product}</div><div className="tiny muted">{fmtDateTime(c.at)} · {c.by ?? '—'} · {c.reason ?? 'sem motivo'}</div></div><span className="num danger-text">{formatBRL(c.totalCents)}</span></div>
          ))}</div>
        ) : <Empty title="Nenhum item cancelado" />}
      </Card>
      {r.staffConsumption.length > 0 && (
        <Card title="Consumo de funcionários" flush>
          <p className="small muted" style={{ padding: '0 16px 8px' }}>Fora das vendas: não foi cobrado. Valor a preço de cardápio e o custo do que saiu do estoque.</p>
          <div className="table-wrap"><table className="table"><thead><tr><th>Funcionário</th><th className="right">Itens</th><th className="right">Valor de cardápio</th><th className="right">Custo</th></tr></thead><tbody>
            {r.staffConsumption.map((x) => <tr key={x.name}><td>{x.name}</td><td className="right num">{x.items}</td><td className="right num">{formatBRL(x.valueCents)}</td><td className="right num muted">{formatBRL(x.costCents)}</td></tr>)}
          </tbody></table></div>
        </Card>
      )}
      <Card title="Caixas" flush>
        {r.cashSessions.length ? (
          <div className="table-wrap"><table className="table"><thead><tr><th>Caixa</th><th>Abertura</th><th>Fechamento</th><th className="right">Troco</th><th className="right">Esperado</th><th className="right">Contado</th><th className="right">Diferença</th></tr></thead><tbody>
            {r.cashSessions.map((c) => (
              <tr key={c.number}>
                <td className="strong">nº {c.number}</td>
                <td className="small">{fmtDateTime(c.openedAt)}<div className="tiny muted">{c.openedBy}</div></td>
                <td className="small">{c.status === 'open' ? <Badge color="green">Aberto</Badge> : <>{fmtDateTime(c.closedAt)}<div className="tiny muted">{c.closedBy}</div></>}</td>
                <td className="right num">{formatBRL(c.openingCents)}</td>
                <td className="right num">{c.expectedCents === null ? '—' : formatBRL(c.expectedCents)}</td>
                <td className="right num">{c.countedCents === null ? '—' : formatBRL(c.countedCents)}</td>
                <td className={`right num strong ${c.differenceCents && c.differenceCents < 0 ? 'danger-text' : c.differenceCents ? 'warning-text' : ''}`}>{c.differenceCents === null ? '—' : formatBRL(c.differenceCents)}</td>
              </tr>
            ))}
          </tbody></table></div>
        ) : <Empty title="Nenhum caixa aberto no período" />}
        {r.cashMovements.length > 0 && (
          <div className="list">{r.cashMovements.map((m, i) => (
            <div key={i} className="list-item"><Badge color={m.type === 'withdrawal' ? 'orange' : 'blue'}>{m.type === 'withdrawal' ? 'Sangria' : 'Suprimento'}</Badge><div className="grow"><div>{m.reason}</div><div className="tiny muted">{fmtDateTime(m.at)} · {m.by ?? '—'}</div></div><span className="num">{m.type === 'withdrawal' ? '− ' : '+ '}{formatBRL(m.amountCents)}</span></div>
          ))}</div>
        )}
      </Card>
      {r.losses.length > 0 && (
        <Card title={`Perdas · ${formatBRL(s.lossesCents)}`} flush>
          <div className="list">{r.losses.map((l, i) => <div key={i} className="list-item"><span className="grow">{l.product} <span className="muted">· {l.reason}</span></span><Badge>{l.count}</Badge><span className="num">{formatBRL(l.costCents)}</span></div>)}</div>
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
