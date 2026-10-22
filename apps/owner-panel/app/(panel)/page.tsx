import { formatBRL, formatQty, type Measure } from '@rupbar/core';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  ChartSpline,
  ClipboardList,
  Clock,
  CreditCard,
  Flame,
  PackageMinus,
  Receipt,
  Trophy,
  Wallet,
  Wind,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { AreaChart, type AreaPoint } from '@/components/charts/AreaChart';
import { BarList } from '@/components/charts/BarList';
import { Donut } from '@/components/charts/Donut';
import { Sparkline } from '@/components/charts/Sparkline';
import { CountUp } from '@/components/CountUp';
import { Badge, Card, Delta, Empty, LinkTabs, stagger } from '@/components/ui';
import {
  activeHookahs,
  comandaCounts,
  currentEstablishment,
  DASHBOARD_PERIODS,
  dashboardPeriod,
  daysBetween,
  hourInBrazil,
  lossesTotal,
  salesByHour,
  salesSummary,
} from '@/lib/data';
import { dayMonth, deltaPct, greeting, longToday, since, weekdayLabel } from '@/lib/format';
import { paymentSegments } from '@/lib/payments';

const HOOKAH_MODE: Record<string, string> = { house: 'Narguilé da casa', own: 'Narguilé próprio', legacy: 'Locação' };

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const period = dashboardPeriod(params.periodo);
  const isToday = period.key === 'hoje';

  const [cur, prev, lossNow, lossPrev, counts, countsPrev, hours, { data: alerts }, { data: products }, { data: pendingLosses }, { data: open }, hookahs] = await Promise.all([
    salesSummary(sb, est.id, period.from, period.to),
    salesSummary(sb, est.id, period.prevFrom, period.prevTo),
    lossesTotal(sb, est.id, period.from, period.to),
    lossesTotal(sb, est.id, period.prevFrom, period.prevTo),
    comandaCounts(sb, est.id, period.from, period.to),
    comandaCounts(sb, est.id, period.prevFrom, period.prevTo),
    isToday ? salesByHour(sb, est.id, period.from, period.to) : Promise.resolve(null),
    sb.from('v_stock_alerts').select('product_id, stock_qty, min_stock').eq('establishment_id', est.id).eq('status', 'open'),
    sb.from('v_products').select('id, name, measure').eq('establishment_id', est.id),
    sb.from('remote_commands').select('id, status').eq('establishment_id', est.id).in('status', ['pending', 'delivered', 'conflict']),
    sb.from('v_comandas').select('id').eq('establishment_id', est.id).eq('status', 'open'),
    activeHookahs(sb, est.id),
  ]);

  const gross = Number(cur?.grossCents ?? 0);
  const prevGross = Number(prev?.grossCents ?? 0);
  const ticket = counts.total ? Math.round(gross / counts.total) : 0;
  const prevTicket = countsPrev.total ? Math.round(prevGross / countsPrev.total) : 0;
  const margin = gross ? Math.round(((gross - Number(cur?.costCents ?? 0)) / gross) * 100) : 0;
  const name = new Map((products ?? []).map((p) => [p.id as string, p as { name: string; measure: Measure }]));
  const openCount = open?.length ?? 0;

  // Série do gráfico: por hora (hoje, até a hora atual) ou por dia (7/30 dias, dias sem venda = 0).
  let points: AreaPoint[];
  if (hours) {
    const upTo = hourInBrazil();
    points = hours.slice(0, upTo + 1).map((v, h) => ({ label: `${h}h`, full: `${h}h–${h + 1}h`, value: v }));
  } else {
    const byDay = new Map((cur?.byDay ?? []).map((d) => [d.day, Number(d.total)]));
    const days = [...new Set([...daysBetween(period.de, period.ate), ...byDay.keys()])].sort();
    points = days.map((d) => ({ label: dayMonth(d), full: weekdayLabel(d), value: byDay.get(d) ?? 0 }));
  }
  const segments = paymentSegments(cur?.byMethod ?? []);
  const periodWord = isToday ? 'hoje' : `nos últimos ${period.days} dias`;

  return (
    <div className="stack-l">
      <AutoRefresh seconds={60} />

      <section className="hero">
        <div className="hero-text">
          <div className="eyebrow">
            <CalendarDays size={14} aria-hidden="true" /> {longToday()}
          </div>
          <h1>
            <span className="hero-greet">{greeting()},</span> <span className="gradient-text">{est.trade_name}</span>
          </h1>
          <p className="subtitle">Veja como o bar está indo {periodWord}. Os números se atualizam sozinhos a cada minuto.</p>
        </div>
        <LinkTabs
          label="Período"
          items={DASHBOARD_PERIODS.map((p) => ({ href: p.key === 'hoje' ? '/' : `/?periodo=${p.key}`, label: p.label, active: p.key === period.key }))}
        />
      </section>

      {(pendingLosses?.length ?? 0) > 0 && (
        <Link href="/perdas" className="banner info">
          <span className="banner-icon" aria-hidden="true">
            <Clock size={18} />
          </span>
          <span className="grow">
            <strong>{pendingLosses!.length} perda(s)</strong> registrada(s) aqui aguardando aplicação ou resolução no PC do bar.
          </span>
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      )}

      <div className="grid-4 stagger">
        <article className="card kpi glow tone-blue">
          <div className="stat-top">
            <h2 className="stat-label">Faturamento</h2>
            <span className="icon-chip blue" aria-hidden="true">
              <ChartSpline size={16} strokeWidth={2.2} />
            </span>
          </div>
          <CountUp className="stat-value" value={gross} format="brl" />
          <Delta value={deltaPct(gross, prevGross)} label={period.compare} />
          <Sparkline values={points.map((p) => p.value)} id="kpi-gross" />
        </article>
        <article className="card kpi glow tone-violet">
          <div className="stat-top">
            <h2 className="stat-label">Ticket médio</h2>
            <span className="icon-chip violet" aria-hidden="true">
              <Receipt size={16} strokeWidth={2.2} />
            </span>
          </div>
          <CountUp className="stat-value" value={ticket} format="brl" />
          <Delta value={deltaPct(ticket, prevTicket)} label={period.compare} />
          <span className="stat-hint">por atendimento (comandas e vendas rápidas)</span>
        </article>
        <article className="card kpi glow tone-teal">
          <div className="stat-top">
            <h2 className="stat-label">Comandas</h2>
            <span className="icon-chip teal" aria-hidden="true">
              <ClipboardList size={16} strokeWidth={2.2} />
            </span>
          </div>
          <CountUp className="stat-value" value={counts.total} format="int" />
          <Delta value={deltaPct(counts.total, countsPrev.total)} label={period.compare} />
          <span className="stat-hint">
            {openCount} aberta{openCount === 1 ? '' : 's'} agora · {counts.quick} venda{counts.quick === 1 ? '' : 's'} rápida{counts.quick === 1 ? '' : 's'}
          </span>
        </article>
        <article className="card kpi glow tone-rose">
          <div className="stat-top">
            <h2 className="stat-label">Perdas</h2>
            <span className="icon-chip rose" aria-hidden="true">
              <PackageMinus size={16} strokeWidth={2.2} />
            </span>
          </div>
          <CountUp className="stat-value" value={lossNow} format="brl" />
          <Delta value={deltaPct(lossNow, lossPrev)} label={period.compare} invert />
          <span className="stat-hint">custo estimado das perdas aplicadas</span>
        </article>
      </div>

      <div className="dash-main">
        <Card
          title={isToday ? 'Faturamento por hora' : 'Faturamento por dia'}
          subtitle={isToday ? 'Hoje, até agora (horário de Brasília)' : `Últimos ${period.days} dias`}
          icon={ChartSpline}
          className="reveal"
          style={stagger(4)}
        >
          <dl className="chart-stats">
            <div>
              <dt>Recebido</dt>
              <dd>{formatBRL(Number(cur?.receivedCents ?? 0))}</dd>
            </div>
            <div>
              <dt>Margem bruta</dt>
              <dd>{margin}%</dd>
            </div>
            <div>
              <dt>Itens vendidos</dt>
              <dd>{Number(cur?.itemsSold ?? 0).toLocaleString('pt-BR')}</dd>
            </div>
            <div>
              <dt>Encerradas</dt>
              <dd>{Number(cur?.closedComandas ?? 0).toLocaleString('pt-BR')}</dd>
            </div>
          </dl>
          {gross > 0 ? (
            <AreaChart points={points} label={isToday ? 'Faturamento por hora hoje' : `Faturamento por dia nos últimos ${period.days} dias`} />
          ) : (
            <Empty title="Sem vendas no período" icon={ChartSpline}>
              Assim que o PC do bar registrar vendas, o gráfico aparece aqui.
            </Empty>
          )}
        </Card>
        <Card title="Formas de pagamento" subtitle="Valores recebidos no período" icon={CreditCard} tone="violet" className="reveal" style={stagger(5)}>
          {segments.length ? (
            <Donut segments={segments} centerLabel="recebido" label="Formas de pagamento" />
          ) : (
            <Empty title="Nenhum pagamento" icon={Wallet}>
              Os pagamentos aparecem aqui conforme as comandas são pagas.
            </Empty>
          )}
        </Card>
      </div>

      <div className="grid-3">
        <Card
          title="Mais vendidos"
          subtitle={`Top produtos ${periodWord}`}
          icon={Trophy}
          tone="amber"
          className="reveal"
          style={stagger(6)}
          actions={
            <Link href="/vendas" className="btn ghost small">
              Ver vendas <ArrowRight size={14} aria-hidden="true" />
            </Link>
          }
        >
          {cur?.topProducts.length ? (
            <BarList
              ranked
              label="Produtos mais vendidos"
              rows={cur.topProducts.slice(0, 6).map((t) => ({
                key: `${t.product_id}-${t.presentation_name}`,
                label: t.product_name,
                sub: t.presentation_name,
                value: Number(t.total),
                display: formatBRL(Number(t.total)),
                meta: `${Number(t.qty).toLocaleString('pt-BR')} vendido${Number(t.qty) === 1 ? '' : 's'}`,
              }))}
            />
          ) : (
            <Empty title="Sem vendas ainda" icon={Trophy} />
          )}
        </Card>

        <Card
          title="Estoque mínimo"
          subtitle={alerts?.length ? `${alerts.length} produto(s) precisam de reposição` : 'Tudo acima do mínimo'}
          icon={AlertTriangle}
          tone="amber"
          flush
          className="reveal"
          style={stagger(7)}
          actions={
            <Link href="/estoque?filtro=baixo" className="btn ghost small">
              Estoque <ArrowRight size={14} aria-hidden="true" />
            </Link>
          }
        >
          {!alerts?.length ? (
            <Empty title="Nenhum produto abaixo do mínimo" icon={AlertTriangle}>
              Seu estoque está em dia.
            </Empty>
          ) : (
            <ul className="list scroll-list">
              {alerts.map((a) => {
                const p = name.get(a.product_id as string);
                const zero = Number(a.stock_qty) <= 0;
                return (
                  <li key={a.product_id as string} className="list-item">
                    <span className={`status-dot ${zero ? 'red' : 'orange'}`} aria-hidden="true" />
                    <div className="grow">
                      <div className="strong ellipsis">{p?.name ?? 'Produto'}</div>
                      <div className="tiny muted">mínimo {formatQty(Number(a.min_stock), p?.measure ?? 'unit')}</div>
                    </div>
                    <Badge color={zero ? 'red' : 'orange'}>{formatQty(Number(a.stock_qty), p?.measure ?? 'unit')}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Agora no bar" subtitle="Movimento em tempo real" icon={Zap} tone="teal" flush className="reveal" style={stagger(8)}>
          <div className="now-grid">
            <Link href="/comandas" className="now-tile">
              <span className="now-value">{openCount}</span>
              <span className="now-label">comanda{openCount === 1 ? '' : 's'} aberta{openCount === 1 ? '' : 's'}</span>
            </Link>
            <div className="now-tile">
              <span className="now-value">{hookahs.length}</span>
              <span className="now-label">narguilé{hookahs.length === 1 ? '' : 's'} aceso{hookahs.length === 1 ? '' : 's'}</span>
            </div>
          </div>
          {hookahs.length ? (
            <ul className="list scroll-list">
              {hookahs.map((h) => (
                <li key={h.id} className="list-item">
                  <span className="icon-chip amber sm" aria-hidden="true">
                    <Flame size={14} />
                  </span>
                  <div className="grow">
                    <div className="strong ellipsis">{h.customer_name || 'Cliente'}</div>
                    <div className="tiny muted">
                      {HOOKAH_MODE[h.mode] ?? 'Narguilé'}
                      {h.rosh_count ? ` · ${h.rosh_count} rosh` : ''}
                    </div>
                  </div>
                  <span className="small muted num" title="Tempo de uso">
                    {since(h.started_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nenhum narguilé em uso" icon={Wind} />
          )}
        </Card>
      </div>
    </div>
  );
}
