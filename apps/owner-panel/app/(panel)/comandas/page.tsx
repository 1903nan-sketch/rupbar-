import { COMANDA_STATUS, comandaLabel, formatBRL, PAYMENT_METHODS, type ComandaStatus, type PaymentMethod } from '@rupbar/core';
import { CircleDollarSign, ClipboardList, Receipt, ShieldCheck, X, Zap } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, Empty, PageHeader, PeriodForm, Stat } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';
import { fmtShort, fmtTime } from '@/lib/format';

export const metadata = { title: 'Comandas' };

interface ComandaRow {
  id: string;
  number: number;
  card_number?: number | null;
  kind?: string | null;
  customer_name: string | null;
  table_label: string | null;
  status: ComandaStatus;
  opened_at: string;
  closed_at: string | null;
}

const STATUS_COLOR: Record<string, 'green' | 'red' | 'gray'> = { open: 'green', closed: 'gray', canceled: 'red' };

function ComandaName({ c }: { c: ComandaRow }) {
  if (c.kind === 'quick') {
    return (
      <span className="comanda-name quick">
        <Zap size={13} aria-hidden="true" /> Venda rápida
      </span>
    );
  }
  return <span className="comanda-name">{comandaLabel({ number: c.number, cardNumber: c.card_number ?? null, kind: c.kind ?? 'regular' })}</span>;
}

export default async function Comandas({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 1);
  const status = typeof params.status === 'string' && ['open', 'closed', 'canceled'].includes(params.status) ? params.status : '';
  const tipo = typeof params.tipo === 'string' && ['regular', 'quick'].includes(params.tipo) ? params.tipo : '';
  const selected = typeof params.id === 'string' ? params.id : null;
  let q = sb.from('v_comandas').select('*').eq('establishment_id', est.id).gte('opened_at', p.from).lt('opened_at', p.to).order('number', { ascending: false }).limit(300);
  if (status) q = q.eq('status', status);
  if (tipo) q = q.eq('kind', tipo);
  const { data } = await q;
  const comandas = (data ?? []) as ComandaRow[];
  const ids = comandas.map((c) => c.id);
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
  const sel = comandas.find((c) => c.id === selected);
  const qs = (extra: Record<string, string>) => {
    const u = new URLSearchParams({ de: p.de, ate: p.ate, ...(status ? { status } : {}), ...(tipo ? { tipo } : {}), ...extra });
    return `?${u.toString()}`;
  };
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const openCount = comandas.filter((c) => c.status === 'open').length;
  const quickCount = comandas.filter((c) => c.kind === 'quick').length;
  const selTotal = sel ? (totals.get(sel.id) ?? 0) : 0;
  const paid = (detail?.payments ?? []).filter((x) => x.status === 'active').reduce((a, x) => a + Number(x.amount_cents), 0);
  const keep: Record<string, string> = { ...(status ? { status } : {}), ...(tipo ? { tipo } : {}) };

  return (
    <div className="stack-l">
      <PageHeader
        title="Comandas"
        eyebrow="Atendimento"
        icon={ClipboardList}
        subtitle="Consulta (somente leitura). Dados pessoais dos clientes permanecem apenas no PC do bar."
        actions={
          <PeriodForm
            de={p.de}
            ate={p.ate}
            keep={keep}
            extra={
              <>
                <div className="field compact">
                  <label htmlFor="status">Situação</label>
                  <select id="status" name="status" className="select" defaultValue={status}>
                    <option value="">Todas</option>
                    <option value="open">Abertas</option>
                    <option value="closed">Encerradas</option>
                    <option value="canceled">Canceladas</option>
                  </select>
                </div>
                <div className="field compact">
                  <label htmlFor="tipo">Tipo</label>
                  <select id="tipo" name="tipo" className="select" defaultValue={tipo}>
                    <option value="">Todos</option>
                    <option value="regular">Comandas</option>
                    <option value="quick">Vendas rápidas</option>
                  </select>
                </div>
              </>
            }
          />
        }
      />

      <div className="grid-3 stagger">
        <Stat label="Atendimentos" value={comandas.length.toLocaleString('pt-BR')} hint={`${quickCount} venda${quickCount === 1 ? '' : 's'} rápida${quickCount === 1 ? '' : 's'}`} icon={ClipboardList} />
        <Stat label="Abertas agora" value={openCount.toLocaleString('pt-BR')} hint="no período filtrado" icon={Receipt} tone="teal" />
        <Stat label="Total lançado" value={formatBRL(sum)} hint="itens ativos das comandas listadas" icon={CircleDollarSign} tone="violet" />
      </div>

      <div className={`split ${sel ? 'has-detail' : ''}`}>
        <Card flush className="reveal">
          {!comandas.length ? (
            <Empty title="Nenhuma comanda no período" icon={ClipboardList}>
              Ajuste o período ou os filtros para ver outros atendimentos.
            </Empty>
          ) : (
            <div className="table-wrap tall">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Comanda</th>
                    <th scope="col">Cliente</th>
                    <th scope="col">Mesa</th>
                    <th scope="col">Abertura</th>
                    <th scope="col">Situação</th>
                    <th scope="col" className="right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {comandas.map((c) => (
                    <tr key={c.id} className={`clickable ${c.id === selected ? 'selected' : ''}`}>
                      <td>
                        <Link href={qs({ id: c.id })} className="row-link" scroll={false} aria-current={c.id === selected ? 'true' : undefined}>
                          <ComandaName c={c} />
                        </Link>
                      </td>
                      <td>{c.customer_name || <span className="muted">—</span>}</td>
                      <td className="muted">{c.table_label ?? '—'}</td>
                      <td className="small num">{fmtShort(c.opened_at)}</td>
                      <td>
                        <Badge color={STATUS_COLOR[c.status] ?? 'gray'} dot pulse={c.status === 'open'}>
                          {COMANDA_STATUS[c.status] ?? c.status}
                        </Badge>
                      </td>
                      <td className="right num strong">{formatBRL(totals.get(c.id) ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {sel && detail && (
          <Card
            key={sel.id}
            className="detail-card"
            title={
              <div>
                <h2 className="card-title">
                  <ComandaName c={sel} />
                </h2>
                <p className="card-sub">
                  {sel.customer_name || 'Cliente não informado'}
                  {sel.table_label ? ` · mesa ${sel.table_label}` : ''} · aberta às {fmtTime(sel.opened_at)}
                </p>
              </div>
            }
            icon={sel.kind === 'quick' ? Zap : Receipt}
            tone={sel.kind === 'quick' ? 'violet' : 'blue'}
            flush
            actions={
              <Link href={qs({})} className="btn ghost icon" aria-label="Fechar detalhes" scroll={false}>
                <X size={18} aria-hidden="true" />
              </Link>
            }
          >
            <ul className="list">
              {detail.items.map((i) => {
                const active = i.status === 'active';
                return (
                  <li key={i.id as string} className={`list-item ${active ? '' : 'canceled'}`}>
                    <span className="qty-chip num">{i.quantity as number}×</span>
                    <div className="grow">
                      <div className="item-name">
                        {i.product_name as string} <span className="muted">· {i.presentation_name as string}</span>
                      </div>
                      {!active && <div className="tiny danger-text">Cancelado: {(i.cancel_reason as string) ?? 'sem motivo'}</div>}
                    </div>
                    <span className="num">{formatBRL(Number(i.quantity) * Number(i.unit_price_cents))}</span>
                  </li>
                );
              })}
              {!detail.items.length && (
                <li className="list-item muted small">Nenhum item lançado.</li>
              )}
              {detail.payments.map((pay) => (
                <li key={pay.id as string} className={`list-item ${pay.status === 'active' ? '' : 'canceled'}`}>
                  <Badge color="blue">Pagamento</Badge>
                  <span className="grow small">
                    {PAYMENT_METHODS[pay.method as PaymentMethod] ?? (pay.method as string)} · {fmtShort(pay.created_at as string)}
                    {pay.status !== 'active' && ' (estornado)'}
                  </span>
                  <span className="num strong">{formatBRL(Number(pay.amount_cents))}</span>
                </li>
              ))}
            </ul>
            <div className="detail-total">
              <div>
                <span className="muted small">Total dos itens</span>
                <strong className="num">{formatBRL(selTotal)}</strong>
              </div>
              <div>
                <span className="muted small">Pago</span>
                <strong className="num">{formatBRL(paid)}</strong>
              </div>
              {sel.status === 'closed' ? (
                <Badge color="green">
                  <ShieldCheck size={12} aria-hidden="true" /> Encerrada
                </Badge>
              ) : null}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
