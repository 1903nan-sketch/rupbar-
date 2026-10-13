import { formatBRL, PAYMENT_METHODS, type PaymentMethod } from '@rupbar/core';
import { Bars, Card, PageHeader, PeriodForm, Stat } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';

export const metadata = { title: 'Vendas' };

interface Summary {
  grossCents: number;
  costCents: number;
  itemsSold: number;
  receivedCents: number;
  closedComandas: number;
  byDay: { day: string; total: number; cost: number }[];
  byMethod: { method: PaymentMethod; total: number; count: number }[];
  byCategory: { category: string; total: number; qty: number; cost: number }[];
  topProducts: { product_id: string; product_name: string; presentation_name: string; qty: number; total: number; cost: number }[];
}

export default async function Sales({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 30);
  const ids = typeof params.comparar === 'string' ? params.comparar.split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 8) : [];
  const [{ data }, { data: products }, compare] = await Promise.all([
    sb.rpc('rupbar_sales_summary', { p_establishment_id: est.id, p_from: p.from, p_to: p.to }),
    sb.from('v_products').select('id, name').eq('establishment_id', est.id).eq('active', true).order('name'),
    ids.length ? sb.rpc('rupbar_product_comparison', { p_establishment_id: est.id, p_from: p.from, p_to: p.to, p_product_ids: ids }) : Promise.resolve({ data: null }),
  ]);
  const s = data as Summary | null;
  if (!s) return <p className="muted">Sem dados.</p>;
  const margin = s.grossCents ? Math.round(((s.grossCents - s.costCents) / s.grossCents) * 100) : 0;
  const cmp = (compare.data ?? []) as { product_id: string; name: string; qty: number; total: number; cost: number; loss_cost: number }[];

  return (
    <div className="stack-l">
      <PageHeader title="Vendas" actions={<PeriodForm de={p.de} ate={p.ate} />} />
      <div className="grid-4">
        <Stat label="Faturamento" value={formatBRL(s.grossCents)} hint={`${s.itemsSold} itens`} />
        <Stat label="Recebido" value={formatBRL(s.receivedCents)} hint={`${s.closedComandas} comandas`} />
        <Stat label="Custo estimado" value={formatBRL(s.costCents)} />
        <Stat label="Margem bruta" value={`${margin}%`} hint={formatBRL(s.grossCents - s.costCents)} />
      </div>
      <div className="grid-2">
        <Card title="Por dia">{s.byDay.length ? <Bars rows={s.byDay.map((r) => ({ label: r.day.split('-').reverse().join('/'), value: r.total, display: formatBRL(r.total) }))} /> : <p className="muted">Sem vendas.</p>}</Card>
        <Card title="Por categoria">{s.byCategory.length ? <Bars rows={s.byCategory.map((r) => ({ label: r.category, value: r.total, display: formatBRL(r.total) }))} /> : <p className="muted">Sem vendas.</p>}</Card>
        <Card title="Por forma de pagamento">{s.byMethod.length ? <Bars rows={s.byMethod.map((r) => ({ label: `${PAYMENT_METHODS[r.method] ?? r.method} (${r.count})`, value: r.total, display: formatBRL(r.total) }))} /> : <p className="muted">Sem pagamentos.</p>}</Card>
        <Card title="Comparar produtos">
          <form method="get" className="stack">
            <input type="hidden" name="de" value={p.de} />
            <input type="hidden" name="ate" value={p.ate} />
            <select className="select" name="comparar" multiple size={6} defaultValue={ids} style={{ height: 'auto' }}>
              {(products ?? []).map((x) => <option key={x.id as string} value={x.id as string}>{x.name as string}</option>)}
            </select>
            <span className="tiny muted">Segure Ctrl (ou Cmd) para escolher até 8 produtos.</span>
            <button className="btn" type="submit">Comparar</button>
          </form>
        </Card>
      </div>
      {cmp.length > 0 && (
        <Card title="Comparação" flush>
          <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th className="right">Qtd.</th><th className="right">Faturamento</th><th className="right">Custo</th><th className="right">Margem</th><th className="right">Perdas</th></tr></thead><tbody>
            {cmp.map((r) => <tr key={r.product_id}><td className="strong">{r.name}</td><td className="right num">{r.qty}</td><td className="right num">{formatBRL(Number(r.total))}</td><td className="right num">{formatBRL(Number(r.cost))}</td><td className="right num">{r.total ? `${Math.round(((r.total - r.cost) / r.total) * 100)}%` : '—'}</td><td className="right num danger-text">{Number(r.loss_cost) ? formatBRL(Number(r.loss_cost)) : '—'}</td></tr>)}
          </tbody></table></div>
        </Card>
      )}
      <Card title="Produtos mais vendidos" flush>
        <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th className="right">Qtd.</th><th className="right">Faturamento</th><th className="right">Custo</th><th className="right">Margem</th></tr></thead><tbody>
          {s.topProducts.map((t) => <tr key={`${t.product_id}-${t.presentation_name}`}><td>{t.product_name} <span className="muted">· {t.presentation_name}</span></td><td className="right num">{t.qty}</td><td className="right num">{formatBRL(Number(t.total))}</td><td className="right num muted">{formatBRL(Number(t.cost))}</td><td className="right num">{t.total ? `${Math.round(((t.total - t.cost) / t.total) * 100)}%` : '—'}</td></tr>)}
        </tbody></table></div>
      </Card>
    </div>
  );
}
