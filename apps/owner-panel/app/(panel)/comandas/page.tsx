import { COMANDA_STATUS, formatBRL, PAYMENT_METHODS, type ComandaStatus, type PaymentMethod } from '@rupbar/core';
import Link from 'next/link';
import { Badge, Card, Empty, PageHeader, PeriodForm } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';

export const metadata = { title: 'Comandas' };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default async function Comandas({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 1);
  const status = typeof params.status === 'string' ? params.status : '';
  const selected = typeof params.id === 'string' ? params.id : null;
  let q = sb.from('v_comandas').select('*').eq('establishment_id', est.id).gte('opened_at', p.from).lt('opened_at', p.to).order('number', { ascending: false }).limit(300);
  if (status) q = q.eq('status', status);
  const { data: comandas } = await q;
  const ids = (comandas ?? []).map((c) => c.id as string);
  const { data: items } = ids.length
    ? await sb.from('v_comanda_items').select('comanda_id, quantity, unit_price_cents, status').eq('establishment_id', est.id).in('comanda_id', ids)
    : { data: [] };
  const totals = new Map<string, number>();
  for (const i of items ?? []) if (i.status === 'active') totals.set(i.comanda_id as string, (totals.get(i.comanda_id as string) ?? 0) + Number(i.quantity) * Number(i.unit_price_cents));

  let detail: null | { items: Record<string, unknown>[]; payments: Record<string, unknown>[] } = null;
  if (selected) {
    const [{ data: di }, { data: dp }] = await Promise.all([
      sb.from('v_comanda_items').select('*').eq('establishment_id', est.id).eq('comanda_id', selected).order('created_at'),
      sb.from('v_payments').select('*').eq('establishment_id', est.id).eq('comanda_id', selected).order('created_at'),
    ]);
    detail = { items: di ?? [], payments: dp ?? [] };
  }
  const sel = (comandas ?? []).find((c) => c.id === selected);
  const link = (id: string) => `?de=${p.de}&ate=${p.ate}${status ? `&status=${status}` : ''}&id=${id}`;

  return (
    <div className="stack-l">
      <PageHeader title="Comandas" subtitle="Consulta (somente leitura). Dados pessoais dos clientes permanecem apenas no PC do bar." actions={
        <PeriodForm de={p.de} ate={p.ate} extra={
          <div className="field"><label htmlFor="status">Situação</label>
            <select id="status" name="status" className="select" defaultValue={status}><option value="">Todas</option><option value="open">Abertas</option><option value="closed">Encerradas</option><option value="canceled">Canceladas</option></select>
          </div>
        } />
      } />
      <div className="grid" style={{ gridTemplateColumns: sel ? 'minmax(0,1.2fr) minmax(0,1fr)' : '1fr', alignItems: 'start' }}>
        <Card flush>
          {!comandas?.length ? <Empty title="Nenhuma comanda no período" /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Nº</th><th>Cliente</th><th>Mesa</th><th>Abertura</th><th>Situação</th><th className="right">Total</th></tr></thead><tbody>
              {comandas.map((c) => (
                <tr key={c.id as string} className="clickable" style={c.id === selected ? { background: 'var(--accent-soft)' } : undefined}>
                  <td><Link href={link(c.id as string)} className="strong">#{c.number as number}</Link></td>
                  <td>{c.customer_name as string}</td>
                  <td className="muted">{(c.table_label as string) ?? '—'}</td>
                  <td className="small">{fmt(c.opened_at as string)}</td>
                  <td><Badge color={c.status === 'open' ? 'green' : c.status === 'canceled' ? 'red' : undefined}>{COMANDA_STATUS[c.status as ComandaStatus]}</Badge></td>
                  <td className="right num">{formatBRL(totals.get(c.id as string) ?? 0)}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
        {sel && detail && (
          <Card title={`Comanda #${sel.number} — ${sel.customer_name}`} flush>
            <div className="list">
              {detail.items.map((i) => (
                <div key={i.id as string} className="list-item" style={{ opacity: i.status === 'active' ? 1 : 0.5 }}>
                  <span className="strong num">{i.quantity as number}×</span>
                  <div className="grow">
                    <div style={{ textDecoration: i.status === 'active' ? undefined : 'line-through' }}>{i.product_name as string} <span className="muted">· {i.presentation_name as string}</span></div>
                    {i.status !== 'active' && <div className="tiny danger-text">Cancelado: {i.cancel_reason as string}</div>}
                  </div>
                  <span className="num">{formatBRL(Number(i.quantity) * Number(i.unit_price_cents))}</span>
                </div>
              ))}
              {detail.payments.map((pay) => (
                <div key={pay.id as string} className="list-item" style={{ opacity: pay.status === 'active' ? 1 : 0.5 }}>
                  <Badge color="blue">Pagamento</Badge>
                  <span className="grow">{PAYMENT_METHODS[pay.method as PaymentMethod]} · {fmt(pay.created_at as string)}{pay.status !== 'active' && ' (estornado)'}</span>
                  <span className="num strong">{formatBRL(Number(pay.amount_cents))}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
