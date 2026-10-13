import { formatBRL } from '@rupbar/core';
import { BarChart3, ChartSpline, Coins, CreditCard, GitCompareArrows, Layers, Percent, Receipt, Trophy, Wallet } from 'lucide-react';
import { AreaChart } from '@/components/charts/AreaChart';
import { BarList } from '@/components/charts/BarList';
import { Donut } from '@/components/charts/Donut';
import { CountUp } from '@/components/CountUp';
import { Card, Empty, PageHeader, PeriodForm, Stat, stagger } from '@/components/ui';
import { currentEstablishment, daysBetween, periodFrom, salesSummary } from '@/lib/data';
import { dayMonth, weekdayLabel } from '@/lib/format';
import { paymentSegments } from '@/lib/payments';

export const metadata = { title: 'Vendas' };

const pctOf = (total: number, cost: number) => (total ? `${Math.round(((total - cost) / total) * 100)}%` : '—');

export default async function Sales({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 30);
  // Aceita ?comparar=a,b (link) e ?comparar=a&comparar=b (formulário).
  const rawIds = Array.isArray(params.comparar) ? params.comparar : typeof params.comparar === 'string' ? [params.comparar] : [];
  const ids = [...new Set(rawIds.flatMap((x) => x.split(',')).filter((x) => /^[0-9a-f-]{36}$/.test(x)))].slice(0, 8);
  const [s, { data: products }, compare] = await Promise.all([
    salesSummary(sb, est.id, p.from, p.to),
    sb.from('v_products').select('id, name').eq('establishment_id', est.id).eq('active', true).order('name'),
    ids.length ? sb.rpc('rupbar_product_comparison', { p_establishment_id: est.id, p_from: p.from, p_to: p.to, p_product_ids: ids }) : Promise.resolve({ data: null }),
  ]);
  const header = <PageHeader title="Vendas" eyebrow="Relatórios" subtitle="Faturamento, custos e margens do período." icon={BarChart3} actions={<PeriodForm de={p.de} ate={p.ate} />} />;
  if (!s) {
    return (
      <div className="stack-l">
        {header}
        <Card>
          <Empty title="Sem dados" icon={BarChart3}>
            Não foi possível carregar o resumo de vendas deste período.
          </Empty>
        </Card>
      </div>
    );
  }
  const gross = Number(s.grossCents);
  const cost = Number(s.costCents);
  const margin = gross ? Math.round(((gross - cost) / gross) * 100) : 0;
  const cmp = (compare.data ?? []) as { product_id: string; name: string; qty: number; total: number; cost: number; loss_cost: number }[];
  const byDay = new Map(s.byDay.map((d) => [d.day, Number(d.total)]));
  const days = [...new Set([...daysBetween(p.de, p.ate), ...byDay.keys()])].sort();
  const points = days.map((d) => ({ label: dayMonth(d), full: weekdayLabel(d), value: byDay.get(d) ?? 0 }));
  const segments = paymentSegments(s.byMethod);

  return (
    <div className="stack-l">
      {header}
      <div className="grid-4 stagger">
        <Stat label="Faturamento" value={<CountUp value={gross} format="brl" />} hint={`${Number(s.itemsSold).toLocaleString('pt-BR')} itens vendidos`} icon={ChartSpline} />
        <Stat label="Recebido" value={<CountUp value={Number(s.receivedCents)} format="brl" />} hint={`${s.closedComandas} comandas encerradas`} icon={Wallet} tone="teal" />
        <Stat label="Custo estimado" value={<CountUp value={cost} format="brl" />} hint="custo médio dos itens vendidos" icon={Coins} tone="amber" />
        <Stat label="Margem bruta" value={<CountUp value={margin} format="percent" />} hint={formatBRL(gross - cost)} icon={Percent} tone="violet" />
      </div>

      <div className="dash-main">
        <Card title="Faturamento por dia" subtitle={`${dayMonth(p.de)} a ${dayMonth(p.ate)}`} icon={ChartSpline} className="reveal" style={stagger(4)}>
          {gross > 0 ? (
            <AreaChart points={points} label="Faturamento por dia no período" />
          ) : (
            <Empty title="Sem vendas no período" icon={ChartSpline} />
          )}
        </Card>
        <Card title="Formas de pagamento" subtitle="Valores recebidos" icon={CreditCard} tone="violet" className="reveal" style={stagger(5)}>
          {segments.length ? <Donut segments={segments} centerLabel="recebido" label="Formas de pagamento" /> : <Empty title="Sem pagamentos" icon={Wallet} />}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Por categoria" subtitle="Faturamento e margem de cada categoria" icon={Layers} tone="teal" className="reveal" style={stagger(6)}>
          {s.byCategory.length ? (
            <BarList
              label="Faturamento por categoria"
              rows={s.byCategory.map((r) => ({
                key: r.category,
                label: r.category,
                value: Number(r.total),
                display: formatBRL(Number(r.total)),
                meta: `${Number(r.qty).toLocaleString('pt-BR')} itens · margem ${pctOf(Number(r.total), Number(r.cost))}`,
              }))}
            />
          ) : (
            <Empty title="Sem vendas" icon={Layers} />
          )}
        </Card>
        <Card title="Comparar produtos" subtitle="Escolha até 8 produtos para ver lado a lado" icon={GitCompareArrows} tone="blue" className="reveal" style={stagger(7)}>
          <form method="get" className="stack">
            <input type="hidden" name="de" value={p.de} />
            <input type="hidden" name="ate" value={p.ate} />
            {(products ?? []).length ? (
              <fieldset className="pick-grid">
                <legend className="sr-only">Produtos para comparar</legend>
                {(products ?? []).map((x) => (
                  <label key={x.id as string} className="pick">
                    <input type="checkbox" name="comparar" value={x.id as string} defaultChecked={ids.includes(x.id as string)} />
                    <span>{x.name as string}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="muted small">Nenhum produto ativo sincronizado.</p>
            )}
            <div className="row between wrap">
              <span className="tiny muted">Os 8 primeiros marcados entram na comparação.</span>
              <button className="btn primary" type="submit">
                <GitCompareArrows size={16} aria-hidden="true" /> Comparar
              </button>
            </div>
          </form>
        </Card>
      </div>

      {cmp.length > 0 && (
        <Card title="Comparação" subtitle="Produtos selecionados no período" icon={GitCompareArrows} flush className="reveal" style={stagger(8)}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  <th scope="col" className="right">Qtd.</th>
                  <th scope="col" className="right">Faturamento</th>
                  <th scope="col" className="right">Custo</th>
                  <th scope="col" className="right">Margem</th>
                  <th scope="col" className="right">Perdas</th>
                </tr>
              </thead>
              <tbody>
                {cmp.map((r) => (
                  <tr key={r.product_id}>
                    <td className="strong">{r.name}</td>
                    <td className="right num">{r.qty}</td>
                    <td className="right num">{formatBRL(Number(r.total))}</td>
                    <td className="right num muted">{formatBRL(Number(r.cost))}</td>
                    <td className="right num">{pctOf(Number(r.total), Number(r.cost))}</td>
                    <td className="right num danger-text">{Number(r.loss_cost) ? formatBRL(Number(r.loss_cost)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Produtos mais vendidos" subtitle={`${s.topProducts.length} produtos com venda no período`} icon={Trophy} tone="amber" flush className="reveal" style={stagger(9)}>
        {!s.topProducts.length ? (
          <Empty title="Nenhum produto vendido no período" icon={Receipt} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Produto</th>
                  <th scope="col" className="right">Qtd.</th>
                  <th scope="col" className="right">Faturamento</th>
                  <th scope="col" className="right">Custo</th>
                  <th scope="col" className="right">Margem</th>
                </tr>
              </thead>
              <tbody>
                {s.topProducts.map((t, i) => (
                  <tr key={`${t.product_id}-${t.presentation_name}`}>
                    <td className="num muted">{i + 1}</td>
                    <td>
                      <span className="strong">{t.product_name}</span> <span className="muted">· {t.presentation_name}</span>
                    </td>
                    <td className="right num">{t.qty}</td>
                    <td className="right num strong">{formatBRL(Number(t.total))}</td>
                    <td className="right num muted">{formatBRL(Number(t.cost))}</td>
                    <td className="right num">{pctOf(Number(t.total), Number(t.cost))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
