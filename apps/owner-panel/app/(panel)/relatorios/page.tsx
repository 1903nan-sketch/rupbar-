import { addDays, barDay, formatBRL, isValidDay, paymentLabel, reportFileName, reportTitle, reportTotals, reportWindow, reportWindowLabel, type FullReport } from '@rupbar/core';
import {
  Ban, BadgePercent, Banknote, ChartSpline, Clock, Coins, Download, FileBarChart, Layers, Percent, Printer, Receipt, ShoppingBag, Users, Vault, Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, Empty, LinkTabs, PageHeader, Stat } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';
import { fmtShort } from '@/lib/format';
import { ReportPeriod } from './ReportPeriod';

export const metadata = { title: 'Relatórios' };

const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '—');
const productLabel = (p: { name: string; presentation: string }) =>
  p.presentation && p.presentation !== 'Unidade' && p.presentation.toLowerCase() !== p.name.toLowerCase() ? `${p.name} · ${p.presentation}` : p.name;

function Bars({ rows }: { rows: { label: string; value: number; hint?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="report-bars">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="report-bar-head">
            <span className="ellipsis">
              {r.label}
              {r.hint ? <span className="muted"> · {r.hint}</span> : null}
            </span>
            <strong className="num">{formatBRL(r.value)}</strong>
          </div>
          <div className="report-bar">
            <span style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function Reports({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const today = barDay();
  const mode = params.modo === 'periodo' ? 'periodo' : 'dia';
  const de = isValidDay(params.de) ? params.de : mode === 'dia' ? today : addDays(today, -6);
  const ate = mode === 'dia' ? de : isValidDay(params.ate) ? params.ate : today;
  const w = reportWindow(de, ate);
  const { data, error } = await sb.rpc('rupbar_full_report', { p_establishment_id: est.id, p_de: w.de, p_ate: w.ate });
  const r = data as FullReport | null;
  const pdf = `/relatorios/pdf?de=${w.de}&ate=${w.ate}`;
  const period = (
    <div className="card report-period">
      <LinkTabs
        label="Tipo de relatório"
        items={[
          { href: `/relatorios?de=${mode === 'dia' ? w.de : today}`, label: 'Um dia', active: mode === 'dia' },
          { href: `/relatorios?modo=periodo&de=${addDays(today, -6)}&ate=${today}`, label: 'Período', active: mode === 'periodo' },
        ]}
      />
      <ReportPeriod key={`${mode}${w.de}${w.ate}`} mode={mode} de={w.de} ate={w.ate} today={today} />
    </div>
  );
  const header = (
    <PageHeader
      title="Relatórios"
      eyebrow="Tudo do dia"
      icon={FileBarChart}
      subtitle={`${reportTitle(w.de, w.ate)} · ${reportWindowLabel(w.de, w.ate)}`}
      actions={
        <div className="report-pdf-actions">
          <a className="btn primary" href={pdf} download={reportFileName(w.de, w.ate)}>
            <Download size={17} aria-hidden="true" /> Baixar PDF
          </a>
          <a className="btn ghost" href={`${pdf}&abrir=1`} target="_blank" rel="noopener">
            <Printer size={17} aria-hidden="true" /> Abrir para imprimir
          </a>
        </div>
      }
    />
  );
  if (error || !r) {
    return (
      <div className="stack-l">
        {header}
        {period}
        <Card>
          <Empty title="Não foi possível carregar o relatório" icon={FileBarChart}>
            Tente de novo em instantes.
          </Empty>
        </Card>
      </div>
    );
  }
  const s = r.summary;
  const t = reportTotals(r);
  const single = w.de === w.ate;
  const timeline = single
    ? r.byHour.map((h) => ({ label: `${String(h.hour).padStart(2, '0')}h`, value: h.totalCents }))
    : r.byDay.map((d) => ({ label: reportTitle(d.day, d.day).replace('-feira', ''), value: d.totalCents }));
  const facts = [
    s.canceledCents ? `Cancelados: ${formatBRL(s.canceledCents)}` : null,
    s.reversedCents ? `Estornos: ${formatBRL(s.reversedCents)}` : null,
    s.canceledComandas ? `Comandas canceladas: ${s.canceledComandas}` : null,
    s.staffCents ? `Consumo de funcionários: ${formatBRL(s.staffCents)} (fora das vendas)` : null,
    s.lossesCents ? `Perdas: ${formatBRL(s.lossesCents)}` : null,
    r.hookah.sessions ? `Narguilés: ${r.hookah.sessions} (${formatBRL(r.hookah.totalCents)})` : null,
    s.stillOpen ? `Ainda abertas: ${s.stillOpen} (${formatBRL(s.stillOpenCents)})` : null,
  ].filter(Boolean);

  return (
    <div className="stack-l">
      {header}
      {period}

      <div className="grid-4 stagger report-stats">
        <Stat label="Vendido (itens)" value={formatBRL(s.grossCents)} hint={`${s.itemsSold} ${s.itemsSold === 1 ? 'item' : 'itens'}`} icon={ChartSpline} />
        <Stat
          label="Descontos"
          value={<span className={s.discountsCents ? 'discount-text' : ''}>{s.discountsCents ? `− ${formatBRL(s.discountsCents)}` : formatBRL(0)}</span>}
          hint={s.serviceFeeCents ? `taxa de serviço + ${formatBRL(s.serviceFeeCents)}` : `${r.discounts.length} comanda${r.discounts.length === 1 ? '' : 's'}`}
          icon={BadgePercent}
          tone="rose"
        />
        <Stat label="Líquido" value={formatBRL(t.netCents)} hint="vendido − descontos + taxa" icon={Receipt} tone="violet" />
        <Stat label="Recebido" value={formatBRL(s.receivedCents)} hint="pagamentos no período" icon={Wallet} tone="teal" />
        <Stat label="Custo estimado" value={formatBRL(s.costCents)} hint="do que saiu do estoque" icon={Coins} tone="amber" />
        <Stat label="Lucro bruto" value={formatBRL(t.marginCents)} hint={`margem ${t.marginPct}%`} icon={Percent} tone="green" />
        <Stat label="Atendimentos" value={t.tickets.toLocaleString('pt-BR')} hint={`${s.closedComandas} comandas · ${s.quickSales} vendas rápidas`} icon={ShoppingBag} />
        <Stat label="Ticket médio" value={formatBRL(t.averageTicketCents)} hint="recebido ÷ atendimentos" icon={Banknote} tone="teal" />
      </div>
      {facts.length > 0 && <p className="small muted staff-note">{facts.join('   ·   ')}</p>}

      <div className="grid-2">
        <Card title="Recebimentos" subtitle="Por forma de pagamento" icon={Wallet} tone="teal" flush>
          {r.payments.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Forma</th>
                    <th scope="col" className="right">Qtd.</th>
                    <th scope="col" className="right">%</th>
                    <th scope="col" className="right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {r.payments.map((p) => (
                    <tr key={p.method}>
                      <td>{paymentLabel(p.method)}</td>
                      <td className="right num">{p.count}</td>
                      <td className="right num muted">{pct(p.totalCents, s.receivedCents)}</td>
                      <td className="right num strong">{formatBRL(p.totalCents)}</td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td>Total</td>
                    <td className="right num">{r.payments.reduce((a, p) => a + p.count, 0)}</td>
                    <td />
                    <td className="right num">{formatBRL(s.receivedCents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Nenhum pagamento no período" icon={Wallet} />
          )}
        </Card>
        <Card title={single ? 'Vendas por hora' : 'Vendas por dia'} subtitle={single ? 'Da abertura à madrugada' : 'O dia do bar vai das 05:00 às 05:00'} icon={Clock}>
          {timeline.length ? <Bars rows={timeline} /> : <Empty title="Sem vendas" icon={Clock} />}
        </Card>
        <Card title="Por categoria" icon={Layers} tone="violet">
          {r.byCategory.length ? <Bars rows={r.byCategory.map((c) => ({ label: c.category, value: c.totalCents, hint: `${c.qty} un.` }))} /> : <Empty title="Sem vendas" icon={Layers} />}
        </Card>
        <Card title="Por atendente" subtitle="Quem lançou os pedidos" icon={Users}>
          {r.byWaiter.length ? <Bars rows={r.byWaiter.map((x) => ({ label: x.name, value: x.totalCents, hint: `${x.orders} pedido${x.orders === 1 ? '' : 's'}` }))} /> : <Empty title="Sem pedidos" icon={Users} />}
        </Card>
      </div>

      <Card title={`Produtos vendidos · ${r.products.length}`} subtitle="Todos os itens do período, do que mais vendeu ao que menos vendeu" icon={ShoppingBag} flush>
        {r.products.length ? (
          <div className="table-wrap tall">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  <th scope="col" className="right">Qtd.</th>
                  <th scope="col" className="right hide-sm">Custo</th>
                  <th scope="col" className="right hide-sm">Margem</th>
                  <th scope="col" className="right">Vendido</th>
                </tr>
              </thead>
              <tbody>
                {r.products.map((p) => (
                  <tr key={`${p.name}|${p.presentation}`}>
                    <td>{productLabel(p)}</td>
                    <td className="right num">{p.qty}</td>
                    <td className="right num muted hide-sm">{formatBRL(p.costCents)}</td>
                    <td className="right num hide-sm">{pct(p.totalCents - p.costCents, p.totalCents)}</td>
                    <td className="right num strong">{formatBRL(p.totalCents)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td>Total</td>
                  <td className="right num">{s.itemsSold}</td>
                  <td className="right num hide-sm">{formatBRL(s.costCents)}</td>
                  <td className="right num hide-sm">{t.marginPct}%</td>
                  <td className="right num">{formatBRL(s.grossCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Nenhum produto vendido no período" icon={ShoppingBag} />
        )}
      </Card>

      <div className="grid-2">
        <Card title={`Descontos · ${formatBRL(s.discountsCents)}`} subtitle="Comandas encerradas com desconto" icon={BadgePercent} tone="rose" flush>
          {r.discounts.length ? (
            <ul className="list">
              {r.discounts.map((d, i) => (
                <li key={i} className="list-item">
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{d.comanda}</strong>
                      {d.customer ? <span className="small muted ellipsis">{d.customer}</span> : null}
                    </div>
                    <div className="small">{d.reason ?? 'sem motivo'}</div>
                    <div className="tiny muted">
                      {d.closedAt ? fmtShort(d.closedAt) : '—'}
                      {d.closedBy ? ` · encerrada por ${d.closedBy}` : ''}
                    </div>
                  </div>
                  <span className="num strong discount-text">− {formatBRL(d.discountCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted card-note">Nenhum desconto no período.</p>
          )}
        </Card>
        <Card title={`Cancelamentos · ${formatBRL(s.canceledCents)}`} subtitle="Itens tirados das comandas, com o motivo" icon={Ban} tone="rose" flush>
          {r.cancellations.length ? (
            <ul className="list">
              {r.cancellations.map((c, i) => (
                <li key={i} className="list-item">
                  <div className="grow">
                    <div>
                      {c.qty}× {c.product}
                    </div>
                    <div className="tiny muted">
                      {fmtShort(c.at)} · {c.by ?? '—'} · {c.reason ?? 'sem motivo'}
                    </div>
                  </div>
                  <span className="num danger-text">{formatBRL(c.totalCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted card-note">Nenhum item cancelado no período.</p>
          )}
        </Card>
      </div>

      <Card title="Caixas" subtitle="Abertura, fechamento e conferência do dinheiro" icon={Vault} tone="amber" flush>
        {r.cashSessions.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Caixa</th>
                  <th scope="col">Abertura</th>
                  <th scope="col">Fechamento</th>
                  <th scope="col" className="right">Troco</th>
                  <th scope="col" className="right">Esperado</th>
                  <th scope="col" className="right">Contado</th>
                  <th scope="col" className="right">Diferença</th>
                </tr>
              </thead>
              <tbody>
                {r.cashSessions.map((c) => (
                  <tr key={c.number}>
                    <td className="strong">nº {c.number}</td>
                    <td className="small">
                      <span className="num">{fmtShort(c.openedAt)}</span>
                      <div className="tiny muted">{c.openedBy ?? '—'}</div>
                    </td>
                    <td className="small">
                      {c.status === 'open' ? (
                        <Badge color="green" dot pulse>
                          Aberto
                        </Badge>
                      ) : (
                        <>
                          <span className="num">{c.closedAt ? fmtShort(c.closedAt) : '—'}</span>
                          <div className="tiny muted">{c.closedBy ?? '—'}</div>
                        </>
                      )}
                    </td>
                    <td className="right num">{formatBRL(c.openingCents)}</td>
                    <td className="right num">
                      {c.expectedCents === null ? '—' : formatBRL(c.expectedCents)}
                      {c.status === 'open' ? <div className="tiny muted">até agora</div> : null}
                    </td>
                    <td className="right num">{c.countedCents === null ? '—' : formatBRL(c.countedCents)}</td>
                    <td className={`right num strong ${c.differenceCents && c.differenceCents < 0 ? 'danger-text' : c.differenceCents ? 'warning-text' : ''}`}>
                      {c.differenceCents === null ? '—' : formatBRL(c.differenceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted card-note">Nenhum caixa aberto no período.</p>
        )}
        {r.cashMovements.length > 0 && (
          <ul className="list">
            {r.cashMovements.map((m, i) => (
              <li key={i} className="list-item">
                {m.type === 'withdrawal' ? <Badge color="orange">Sangria</Badge> : <Badge color="blue">Suprimento</Badge>}
                <div className="grow">
                  <div>{m.reason}</div>
                  <div className="tiny muted">
                    {fmtShort(m.at)} · {m.by ?? '—'}
                  </div>
                </div>
                <span className="num strong">
                  {m.type === 'withdrawal' ? '− ' : '+ '}
                  {formatBRL(m.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(r.staffConsumption.length > 0 || r.losses.length > 0) && (
        <div className="grid-2">
          {r.staffConsumption.length > 0 && (
            <Card title="Consumo de funcionários" subtitle="Não cobrado; fora das vendas (preço de cardápio e custo)" icon={Users} flush>
              <ul className="list">
                {r.staffConsumption.map((x) => (
                  <li key={x.name} className="list-item">
                    <span className="grow">
                      {x.name} <span className="muted small">· {x.items} itens · custo {formatBRL(x.costCents)}</span>
                    </span>
                    <span className="num strong">{formatBRL(x.valueCents)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {r.losses.length > 0 && (
            <Card title={`Perdas · ${formatBRL(s.lossesCents)}`} subtitle="Custo do que se perdeu" icon={Ban} tone="amber" flush>
              <ul className="list">
                {r.losses.map((l, i) => (
                  <li key={i} className="list-item">
                    <span className="grow">
                      {l.product} <span className="muted small">· {l.reason}</span>
                    </span>
                    <Badge>{l.count}</Badge>
                    <span className="num strong">{formatBRL(l.costCents)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <p className="small muted">
        Gráficos e comparação de produtos estão em <Link href="/vendas">Vendas</Link>.
      </p>
    </div>
  );
}
