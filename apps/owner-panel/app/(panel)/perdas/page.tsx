import { formatBRL, formatQty, LOSS_REASONS, type LossReason, type Measure } from '@rupbar/core';
import { CloudUpload, History, Layers, ListChecks, PackageMinus, PlusCircle, Tags } from 'lucide-react';
import { BarList } from '@/components/charts/BarList';
import { CountUp } from '@/components/CountUp';
import { Badge, Card, Empty, PageHeader, PeriodForm, stagger, type BadgeColor } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';
import { fmtShort } from '@/lib/format';
import { cancelCommand } from './actions';
import { LossForm } from './LossForm';

export const metadata = { title: 'Perdas' };

const CMD_STATUS: Record<string, [string, BadgeColor]> = {
  pending: ['Aguardando aplicação', 'orange'],
  delivered: ['Aguardando aplicação', 'orange'],
  applied: ['Aplicada', 'green'],
  conflict: ['Conflito de estoque', 'red'],
  rejected: ['Rejeitada', 'gray'],
  canceled: ['Cancelada', 'gray'],
};

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
  const appliedCount = losses?.filter((l) => l.status === 'applied').length ?? 0;
  const waiting = (commands ?? []).filter((c) => c.status === 'pending' || c.status === 'delivered').length;

  return (
    <div className="stack-l">
      <PageHeader
        title="Perdas"
        eyebrow="Controle"
        icon={PackageMinus}
        subtitle="Somente o proprietário registra perdas. Registros feitos aqui são aplicados pelo PC do bar."
        actions={<PeriodForm de={p.de} ate={p.ate} />}
      />

      <div className="split-form">
        <Card title="Registrar perda" subtitle="Quebra, vencimento, derramamento…" icon={PlusCircle} tone="rose" className="reveal" style={stagger(0)}>
          <LossForm products={(products ?? []).map((x) => ({ id: x.id as string, name: x.name as string, measure: x.measure as string }))} />
        </Card>
        <Card
          title="Registradas pelo painel"
          subtitle={waiting ? `${waiting} aguardando o PC do bar` : 'Fila de envio para o PC do bar'}
          icon={CloudUpload}
          tone="blue"
          flush
          className="reveal"
          style={stagger(1)}
        >
          {!commands?.length ? (
            <Empty title="Nenhuma perda registrada por aqui" icon={CloudUpload}>
              As perdas que você registrar ao lado aparecem nesta fila até o PC do bar aplicá-las.
            </Empty>
          ) : (
            <ul className="list scroll-list tall">
              {commands.map((c) => {
                const pl = c.payload as { productId: string; qty: number; reason: LossReason };
                const pr = prod.get(pl.productId);
                const [label, color] = CMD_STATUS[c.status as string] ?? [c.status as string, 'gray' as const];
                const msg = (c.result as { message?: string } | null)?.message;
                return (
                  <li key={c.id as string} className="list-item">
                    <div className="grow">
                      <div className="strong">
                        {pr?.name ?? 'Produto'} · {formatQty(Number(pl.qty), pr?.measure ?? 'unit')}
                      </div>
                      <div className="tiny muted">
                        {LOSS_REASONS[pl.reason] ?? pl.reason} · {fmtShort(c.created_at as string)}
                        {msg ? ` · ${msg}` : ''}
                      </div>
                    </div>
                    <Badge color={color} dot pulse={c.status === 'pending' || c.status === 'delivered'}>
                      {label}
                    </Badge>
                    {c.status === 'pending' && (
                      <form action={cancelCommand}>
                        <input type="hidden" name="id" value={c.id as string} />
                        <button className="btn ghost small" type="submit">
                          Cancelar
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {r && (
        <div className="grid-3">
          <article className="card kpi glow tone-rose reveal" style={stagger(2)}>
            <div className="stat-top">
              <h2 className="stat-label">Custo estimado das perdas</h2>
              <span className="icon-chip rose" aria-hidden="true">
                <PackageMinus size={16} strokeWidth={2.2} />
              </span>
            </div>
            <CountUp className="stat-value" value={Number(r.totalCostCents)} format="brl" />
            <span className="stat-hint">
              {appliedCount} ocorrência{appliedCount === 1 ? '' : 's'} aplicada{appliedCount === 1 ? '' : 's'} no período
            </span>
          </article>
          <Card title="Por motivo" icon={Tags} tone="amber" className="reveal" style={stagger(3)}>
            {r.byReason.length ? (
              <BarList
                label="Perdas por motivo"
                rows={r.byReason.map((x) => ({
                  key: x.reason,
                  label: LOSS_REASONS[x.reason] ?? x.reason,
                  value: Number(x.cost_cents),
                  display: formatBRL(Number(x.cost_cents)),
                  meta: `${x.count} ocorrência${Number(x.count) === 1 ? '' : 's'}`,
                }))}
              />
            ) : (
              <Empty title="Sem perdas" icon={ListChecks} />
            )}
          </Card>
          <Card title="Por categoria" icon={Layers} tone="violet" className="reveal" style={stagger(4)}>
            {r.byCategory.length ? (
              <BarList
                label="Perdas por categoria"
                rows={r.byCategory.map((x) => ({
                  key: x.category,
                  label: x.category,
                  value: Number(x.cost_cents),
                  display: formatBRL(Number(x.cost_cents)),
                  meta: `${x.count} ocorrência${Number(x.count) === 1 ? '' : 's'}`,
                }))}
              />
            ) : (
              <Empty title="Sem perdas" icon={ListChecks} />
            )}
          </Card>
        </div>
      )}

      <Card title="Histórico de perdas" subtitle="Registradas no PC do bar e pelo painel" icon={History} flush className="reveal" style={stagger(5)}>
        {!losses?.length ? (
          <Empty title="Nenhuma perda no período" icon={History}>
            Que bom! Nenhuma perda registrada entre as datas escolhidas.
          </Empty>
        ) : (
          <div className="table-wrap tall">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Data</th>
                  <th scope="col">Produto</th>
                  <th scope="col" className="right">Quantidade</th>
                  <th scope="col">Motivo</th>
                  <th scope="col">Origem</th>
                  <th scope="col">Situação</th>
                  <th scope="col" className="right">Custo</th>
                </tr>
              </thead>
              <tbody>
                {losses.map((l) => {
                  const pr = prod.get(l.product_id as string);
                  const st = l.status as string;
                  return (
                    <tr key={l.id as string}>
                      <td className="small num">{fmtShort(l.occurred_at as string)}</td>
                      <td className="strong">{pr?.name ?? '—'}</td>
                      <td className="right num">{formatQty(Number(l.applied_qty || l.qty), pr?.measure ?? 'unit')}</td>
                      <td>{LOSS_REASONS[l.reason as LossReason] ?? (l.reason as string)}</td>
                      <td className="small muted">
                        {l.source === 'remote' ? 'Painel online' : 'PC do bar'} · {l.registered_by_name as string}
                      </td>
                      <td>
                        <Badge color={st === 'applied' ? 'green' : st === 'conflict' ? 'red' : st === 'rejected' ? 'gray' : 'orange'} dot>
                          {CMD_STATUS[st]?.[0] ?? (st === 'pending_application' ? 'Aguardando aplicação' : st)}
                        </Badge>
                      </td>
                      <td className="right num strong">{formatBRL(Number(l.cost_cents))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
