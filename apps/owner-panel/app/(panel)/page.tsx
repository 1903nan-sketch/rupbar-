import { formatBRL, formatQty, PAYMENT_METHODS, type Measure, type PaymentMethod } from '@rupbar/core';
import { AlertTriangle, Clock } from 'lucide-react';
import Link from 'next/link';
import { Badge, Bars, Card, PageHeader, Stat } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';

interface Summary {
  grossCents: number;
  costCents: number;
  itemsSold: number;
  receivedCents: number;
  closedComandas: number;
  byDay: { day: string; total: number }[];
  byMethod: { method: PaymentMethod; total: number }[];
  byCategory: { category: string; total: number }[];
  topProducts: { product_name: string; presentation_name: string; qty: number; total: number }[];
}

export default async function Overview() {
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const today = periodFrom({}, 1);
  const week = periodFrom({}, 7);
  const [{ data: day }, { data: wk }, { data: alerts }, { data: products }, { data: pendingLosses }, { data: open }] = await Promise.all([
    sb.rpc('rupbar_sales_summary', { p_establishment_id: est.id, p_from: today.from, p_to: today.to }),
    sb.rpc('rupbar_sales_summary', { p_establishment_id: est.id, p_from: week.from, p_to: week.to }),
    sb.from('v_stock_alerts').select('product_id, stock_qty, min_stock').eq('establishment_id', est.id).eq('status', 'open'),
    sb.from('v_products').select('id, name, measure').eq('establishment_id', est.id),
    sb.from('remote_commands').select('id, status').eq('establishment_id', est.id).in('status', ['pending', 'delivered', 'conflict']),
    sb.from('v_comandas').select('id').eq('establishment_id', est.id).eq('status', 'open'),
  ]);
  const d = day as Summary | null;
  const w = wk as Summary | null;
  const name = new Map((products ?? []).map((p) => [p.id as string, p as { name: string; measure: Measure }]));
  const margin = w && w.grossCents ? Math.round(((w.grossCents - w.costCents) / w.grossCents) * 100) : 0;

  return (
    <div className="stack-l">
      <PageHeader title={est.trade_name} subtitle="Visão geral" />
      {(pendingLosses?.length ?? 0) > 0 && (
        <Link href="/perdas" className="banner warning"><Clock size={18} /> {pendingLosses!.length} perda(s) registrada(s) aqui aguardando aplicação ou resolução no PC do bar.</Link>
      )}
      <div className="grid-4">
        <Stat label="Vendas hoje" value={formatBRL(d?.grossCents ?? 0)} hint={`${d?.itemsSold ?? 0} itens`} />
        <Stat label="Recebido hoje" value={formatBRL(d?.receivedCents ?? 0)} hint={`${d?.closedComandas ?? 0} comandas encerradas`} />
        <Stat label="Comandas abertas" value={open?.length ?? 0} />
        <Stat label="Últimos 7 dias" value={formatBRL(w?.grossCents ?? 0)} hint={`margem bruta ${margin}%`} />
      </div>
      <div className="grid-2">
        <Card title="Vendas por dia (7 dias)">
          {w?.byDay.length ? <Bars rows={w.byDay.map((r) => ({ label: r.day.split('-').reverse().join('/'), value: r.total, display: formatBRL(r.total) }))} /> : <p className="muted">Sem vendas no período.</p>}
        </Card>
        <Card title="Formas de pagamento (7 dias)">
          {w?.byMethod.length ? <Bars rows={w.byMethod.map((r) => ({ label: PAYMENT_METHODS[r.method] ?? r.method, value: r.total, display: formatBRL(r.total) }))} /> : <p className="muted">Sem pagamentos no período.</p>}
        </Card>
      </div>
      <div className="grid-2">
        <Card title={<span className="row"><AlertTriangle size={18} /> Estoque mínimo</span>} flush>
          <div className="list">
            {!alerts?.length && <div className="list-item muted">Nenhum produto abaixo do mínimo.</div>}
            {alerts?.map((a) => {
              const p = name.get(a.product_id as string);
              return (
                <div key={a.product_id as string} className="list-item">
                  <span className="grow">{p?.name ?? 'Produto'}</span>
                  <span className="small muted">mín. {formatQty(Number(a.min_stock), p?.measure ?? 'unit')}</span>
                  <Badge color={Number(a.stock_qty) <= 0 ? 'red' : 'orange'}>{formatQty(Number(a.stock_qty), p?.measure ?? 'unit')}</Badge>
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Mais vendidos (7 dias)" flush>
          <div className="list">
            {!w?.topProducts.length && <div className="list-item muted">Sem vendas.</div>}
            {w?.topProducts.slice(0, 8).map((t) => (
              <div key={`${t.product_name}-${t.presentation_name}`} className="list-item">
                <span className="grow">{t.product_name} <span className="muted">· {t.presentation_name}</span></span>
                <span className="small muted">{t.qty}×</span>
                <span className="num strong">{formatBRL(t.total)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
