import { formatBRL, formatQty, LOSS_REASONS, type LossReason, type Measure } from '@rupbar/core';
import { Badge, Card, Empty, PageHeader, PeriodForm, Stat } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';
import { cancelCommand } from './actions';
import { LossForm } from './LossForm';

export const metadata = { title: 'Perdas' };

const CMD_STATUS: Record<string, [string, 'orange' | 'green' | 'red' | 'blue' | undefined]> = {
  pending: ['Aguardando aplicação', 'orange'],
  delivered: ['Aguardando aplicação', 'orange'],
  applied: ['Aplicada', 'green'],
  conflict: ['Conflito de estoque', 'red'],
  rejected: ['Rejeitada', undefined],
  canceled: ['Cancelada', undefined],
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default async function Losses({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 30);
  const [{ data: products }, { data: commands }, { data: losses }, { data: report }] = await Promise.all([
    sb.from('v_products').select('id, name, measure, category_id').eq('establishment_id', est.id).eq('active', true).eq('stock_tracked', true).order('name'),
    sb.from('remote_commands').select('id, status, payload, result, created_at, applied_at').eq('establishment_id', est.id).eq('type', 'loss.register').order('created_at', { ascending: false }).limit(50),
    sb.from('v_losses').select('*').eq('establishment_id', est.id).gte('occurred_at', p.from).lt('occurred_at', p.to).order('occurred_at', { ascending: false }).limit(300),
    sb.rpc('rupbar_losses_report', { p_establishment_id: est.id, p_from: p.from, p_to: p.to }),
  ]);
  const prod = new Map((products ?? []).map((x) => [x.id as string, x as { name: string; measure: Measure }]));
  const r = report as null | { totalCostCents: number; byCategory: { category: string; count: number; cost_cents: number }[]; byReason: { reason: LossReason; count: number; cost_cents: number }[] };

  return (
    <div className="stack-l">
      <PageHeader title="Perdas" subtitle="Somente o proprietário registra perdas. Registros feitos aqui são aplicados pelo PC do bar." actions={<PeriodForm de={p.de} ate={p.ate} />} />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', alignItems: 'start' }}>
        <Card title="Registrar perda"><LossForm products={(products ?? []).map((x) => ({ id: x.id as string, name: x.name as string, measure: x.measure as string }))} /></Card>
        <Card title="Registradas pelo painel" flush>
          <div className="list">
            {!commands?.length && <div className="list-item muted">Nenhuma perda registrada por aqui.</div>}
            {commands?.map((c) => {
              const pl = c.payload as { productId: string; qty: number; reason: LossReason };
              const pr = prod.get(pl.productId);
              const [label, color] = CMD_STATUS[c.status as string] ?? [c.status as string, undefined];
              const msg = (c.result as { message?: string } | null)?.message;
              return (
                <div key={c.id as string} className="list-item">
                  <div className="grow">
                    <div className="strong">{pr?.name ?? 'Produto'} · {formatQty(Number(pl.qty), pr?.measure ?? 'unit')}</div>
                    <div className="tiny muted">{LOSS_REASONS[pl.reason]} · {fmt(c.created_at as string)}{msg ? ` · ${msg}` : ''}</div>
                  </div>
                  <Badge color={color}>{label}</Badge>
                  {c.status === 'pending' && (
                    <form action={cancelCommand}><input type="hidden" name="id" value={c.id as string} /><button className="btn plain small" type="submit">Cancelar</button></form>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      {r && (
        <div className="grid-3">
          <Stat label="Custo estimado das perdas" value={formatBRL(Number(r.totalCostCents))} hint={`${losses?.filter((l) => l.status === 'applied').length ?? 0} ocorrências aplicadas`} />
          <Card title="Por motivo" flush><div className="list">{r.byReason.map((x) => <div key={x.reason} className="list-item"><span className="grow">{LOSS_REASONS[x.reason]}</span><span className="small muted">{x.count}</span><span className="num">{formatBRL(Number(x.cost_cents))}</span></div>)}{!r.byReason.length && <div className="list-item muted">Sem perdas.</div>}</div></Card>
          <Card title="Por categoria" flush><div className="list">{r.byCategory.map((x) => <div key={x.category} className="list-item"><span className="grow">{x.category}</span><span className="small muted">{x.count}</span><span className="num">{formatBRL(Number(x.cost_cents))}</span></div>)}{!r.byCategory.length && <div className="list-item muted">Sem perdas.</div>}</div></Card>
        </div>
      )}
      <Card title="Histórico de perdas" flush>
        {!losses?.length ? <Empty title="Nenhuma perda no período" /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Data</th><th>Produto</th><th className="right">Quantidade</th><th>Motivo</th><th>Origem</th><th>Situação</th><th className="right">Custo</th></tr></thead><tbody>
            {losses.map((l) => {
              const pr = prod.get(l.product_id as string);
              return (
                <tr key={l.id as string}>
                  <td className="small">{fmt(l.occurred_at as string)}</td>
                  <td>{pr?.name ?? '—'}</td>
                  <td className="right num">{formatQty(Number(l.applied_qty || l.qty), pr?.measure ?? 'unit')}</td>
                  <td>{LOSS_REASONS[l.reason as LossReason]}</td>
                  <td className="small muted">{l.source === 'remote' ? 'Painel online' : 'PC do bar'} · {l.registered_by_name as string}</td>
                  <td><Badge color={l.status === 'applied' ? 'green' : l.status === 'conflict' ? 'red' : 'orange'}>{CMD_STATUS[l.status as string]?.[0] ?? (l.status as string)}</Badge></td>
                  <td className="right num">{formatBRL(Number(l.cost_cents))}</td>
                </tr>
              );
            })}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
