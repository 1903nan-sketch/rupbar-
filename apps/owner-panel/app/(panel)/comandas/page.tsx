import { COMANDA_STATUS, comandaLabel, formatBRL, PAYMENT_METHODS, type ComandaStatus, type PaymentMethod } from '@rupbar/core';
import { ChevronRight, CircleDollarSign, ClipboardList, ClipboardPlus, History, PlusCircle, Receipt, ShieldCheck, X, Zap } from 'lucide-react';
import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { CommandFeed } from '@/components/CommandFeed';
import { LinkRow } from '@/components/LinkRow';
import { ScrollHere } from '@/components/ScrollHere';
import { Badge, Card, Empty, PageHeader, PeriodForm, Stat } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';
import { fmtShort } from '@/lib/format';
import { openComanda } from '../acoes';
import { CancelItemButton, ItemLauncher, type SaleOption } from './ItemLauncher';

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

const UUID = /^[0-9a-f-]{36}$/;
const STATUS_COLOR: Record<string, 'green' | 'red' | 'gray'> = { open: 'green', closed: 'gray', canceled: 'red' };
const FEED_TYPES = ['comanda.open', 'order.create', 'comanda_item.cancel'] as const;

const labelOf = (c: ComandaRow) => comandaLabel({ number: c.number, cardNumber: c.card_number ?? null, kind: c.kind ?? 'regular' });

function ComandaName({ c }: { c: ComandaRow }) {
  if (c.kind === 'quick') {
    return (
      <span className="comanda-name quick">
        <Zap size={13} aria-hidden="true" /> Venda rápida
      </span>
    );
  }
  if (c.kind === 'staff') {
    return (
      <span className="comanda-name">
        {labelOf(c)} <Badge color="purple">Funcionário</Badge>
      </span>
    );
  }
  return <span className="comanda-name">{labelOf(c)}</span>;
}

export default async function Comandas({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 1);
  const status = typeof params.status === 'string' && ['open', 'closed', 'canceled'].includes(params.status) ? params.status : '';
  const tipo = typeof params.tipo === 'string' && ['regular', 'quick'].includes(params.tipo) ? params.tipo : '';
  const selected = typeof params.id === 'string' && UUID.test(params.id) ? params.id : null;

  let q = sb.from('v_comandas').select('*').eq('establishment_id', est.id).order('number', { ascending: false }).limit(300);
  if (status !== 'open') q = q.gte('opened_at', p.from).lt('opened_at', p.to);
  if (status) q = q.eq('status', status);
  if (tipo) q = q.eq('kind', tipo);
  // Abertas agora (de qualquer dia) e a comanda tocada, mesmo fora do período.
  const [{ data }, { data: openData }, { data: selData }, { data: di }, { data: dp }] = await Promise.all([
    q,
    sb.from('v_comandas').select('*').eq('establishment_id', est.id).eq('status', 'open').neq('kind', 'quick').order('opened_at').limit(200),
    selected ? sb.from('v_comandas').select('*').eq('establishment_id', est.id).eq('id', selected).limit(1) : Promise.resolve({ data: null }),
    selected ? sb.from('v_comanda_items').select('*').eq('establishment_id', est.id).eq('comanda_id', selected).order('created_at') : Promise.resolve({ data: null }),
    selected ? sb.from('v_payments').select('*').eq('establishment_id', est.id).eq('comanda_id', selected).order('created_at') : Promise.resolve({ data: null }),
  ]);
  const comandas = (data ?? []) as ComandaRow[];
  const open = (openData ?? []) as ComandaRow[];
  const sel = ((selData ?? []) as ComandaRow[])[0] ?? null;
  const detail = sel ? { items: (di ?? []) as Record<string, unknown>[], payments: (dp ?? []) as Record<string, unknown>[] } : null;

  const totalsFor = async (ids: string[]) => {
    const totals = new Map<string, number>();
    if (!ids.length) return totals;
    const { data: items } = await sb.from('v_comanda_items').select('comanda_id, quantity, unit_price_cents, status').eq('establishment_id', est.id).in('comanda_id', ids);
    for (const i of items ?? []) if (i.status === 'active') totals.set(i.comanda_id as string, (totals.get(i.comanda_id as string) ?? 0) + Number(i.quantity) * Number(i.unit_price_cents));
    return totals;
  };
  const [totals, openTotals] = await Promise.all([totalsFor(comandas.map((c) => c.id)), totalsFor(open.map((c) => c.id))]);

  // Itens à venda para lançar na comanda aberta (nome, apresentação e preço).
  let saleOptions: SaleOption[] = [];
  if (sel && sel.status === 'open' && sel.kind !== 'quick') {
    const [{ data: pres }, { data: prods }, { data: cats }] = await Promise.all([
      sb.from('v_presentations').select('id, product_id, name, price_cents, sort_order').eq('establishment_id', est.id).eq('active', true).eq('menu_visible', true),
      sb.from('v_products').select('id, name, category_id').eq('establishment_id', est.id).eq('active', true),
      sb.from('v_categories').select('id, name').eq('establishment_id', est.id),
    ]);
    const prod = new Map((prods ?? []).map((x) => [x.id as string, x as { name: string; category_id: string }]));
    const cat = new Map((cats ?? []).map((x) => [x.id as string, x.name as string]));
    saleOptions = (pres ?? []).flatMap((x) => {
      const pr = prod.get(x.product_id as string);
      if (!pr) return [];
      const pn = String(x.name);
      const name = pn === 'Unidade' || pn.toLocaleLowerCase('pt-BR') === pr.name.toLocaleLowerCase('pt-BR') ? pr.name : `${pr.name} · ${pn}`;
      return [{ presentationId: x.id as string, name, category: cat.get(pr.category_id) ?? '', priceCents: Number(x.price_cents) }];
    }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  const keep: Record<string, string> = { ...(status ? { status } : {}), ...(tipo ? { tipo } : {}) };
  const qs = (extra: Record<string, string>) => `?${new URLSearchParams({ de: p.de, ate: p.ate, ...keep, ...extra }).toString()}`;
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const quickCount = comandas.filter((c) => c.kind === 'quick').length;
  const activeItems = (detail?.items ?? []).filter((i) => i.status === 'active');
  const selTotal = activeItems.reduce((a, i) => a + Number(i.quantity) * Number(i.unit_price_cents), 0);
  const paid = (detail?.payments ?? []).filter((x) => x.status === 'active').reduce((a, x) => a + Number(x.amount_cents), 0);

  return (
    <div className="stack-l">
      <PageHeader
        title="Comandas"
        eyebrow="Atendimento"
        icon={ClipboardList}
        subtitle="Toque numa comanda aberta para ver, lançar ou tirar itens. O PC do bar aplica em segundos. Dados pessoais dos clientes ficam só no PC."
      />

      {sel && detail && (
        <div className="split-form wide-first">
          <Card
            key={sel.id}
            id="comanda"
            className="detail-card"
            title={
              <div>
                <h2 className="card-title">
                  <ComandaName c={sel} />
                </h2>
                <p className="card-sub">
                  {sel.customer_name || 'Cliente não informado'}
                  {sel.table_label ? ` · mesa ${sel.table_label}` : ''} · aberta em {fmtShort(sel.opened_at)}
                </p>
              </div>
            }
            icon={sel.kind === 'quick' ? Zap : Receipt}
            tone={sel.kind === 'quick' ? 'violet' : 'blue'}
            flush
            actions={
              <Link href={qs({})} className="btn ghost icon" aria-label="Fechar comanda na tela" scroll={false}>
                <X size={18} aria-hidden="true" />
              </Link>
            }
          >
            <ScrollHere />
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
                    {active && sel.status === 'open' && <CancelItemButton itemId={i.id as string} itemLabel={`${i.quantity}× ${i.product_name as string}`} />}
                  </li>
                );
              })}
              {!detail.items.length && <li className="list-item muted small">Nenhum item lançado.</li>}
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
            {sel.status === 'open' && sel.kind !== 'quick' && (
              <div className="detail-launch">
                <h3 className="mini-label">Lançar itens</h3>
                <ItemLauncher comandaId={sel.id} comandaLabel={labelOf(sel)} options={saleOptions} />
              </div>
            )}
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
              ) : (
                <Badge color={STATUS_COLOR[sel.status] ?? 'gray'} dot pulse={sel.status === 'open'}>
                  {COMANDA_STATUS[sel.status] ?? sel.status}
                </Badge>
              )}
            </div>
          </Card>
          <CommandFeed types={[...FEED_TYPES]} path="/comandas" />
        </div>
      )}

      <div className="split-form wide-first">
        <Card id="abertas" title={`Abertas agora · ${open.length}`} subtitle="De qualquer dia. Toque para abrir." icon={Receipt} tone="teal">
          {!open.length ? (
            <Empty title="Nenhuma comanda aberta" icon={Receipt}>
              Abra uma comanda aqui ao lado ou no PC do bar. Ela aparece nesta lista assim que o PC sincronizar.
            </Empty>
          ) : (
            <div className="open-grid">
              {open.map((c) => (
                <Link key={c.id} href={qs({ id: c.id })} scroll={false} className={`open-tile ${c.id === selected ? 'selected' : ''}`} aria-current={c.id === selected ? 'true' : undefined}>
                  <span className="open-tile-head">
                    <ComandaName c={c} />
                    <ChevronRight size={16} aria-hidden="true" />
                  </span>
                  <span className="open-tile-who">
                    {c.customer_name || 'Sem nome'}
                    {c.table_label ? ` · mesa ${c.table_label}` : ''}
                  </span>
                  <span className="open-tile-foot">
                    <span className="tiny muted num">desde {fmtShort(c.opened_at)}</span>
                    <strong className="num">{formatBRL(openTotals.get(c.id) ?? 0)}</strong>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>
        <div className="stack-l">
          <Card title="Abrir comanda" subtitle="Pelo cartão, nome ou mesa" icon={ClipboardPlus} tone="teal">
            <ActionForm action={openComanda} submit="Abrir comanda" icon={<PlusCircle size={17} aria-hidden="true" />} block>
              <div className="grid-2 tight">
                <div className="field">
                  <label htmlFor="cardNumber">Nº do cartão</label>
                  <input id="cardNumber" name="cardNumber" className="input" inputMode="numeric" pattern="[0-9]*" placeholder="Ex.: 12" />
                </div>
                <div className="field">
                  <label htmlFor="table">Mesa</label>
                  <input id="table" name="table" className="input" maxLength={20} placeholder="Opcional" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="customerName">Nome do cliente</label>
                <input id="customerName" name="customerName" className="input" maxLength={80} placeholder="Opcional" />
              </div>
            </ActionForm>
          </Card>
          {!sel && <CommandFeed types={[...FEED_TYPES]} path="/comandas" />}
        </div>
      </div>

      <div className="page-header section-head">
        <div className="page-heading">
          <span className="page-icon sm" aria-hidden="true">
            <History size={18} strokeWidth={2} />
          </span>
          <div className="grow">
            <h2>Histórico</h2>
            <p className="subtitle">Comandas e vendas rápidas do período</p>
          </div>
        </div>
        <div className="page-actions">
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
        </div>
      </div>

      <div className="grid-3 stagger">
        <Stat label="Atendimentos" value={comandas.length.toLocaleString('pt-BR')} hint={`${quickCount} venda${quickCount === 1 ? '' : 's'} rápida${quickCount === 1 ? '' : 's'}`} icon={ClipboardList} />
        <Stat label="Abertas agora" value={open.length.toLocaleString('pt-BR')} hint="de qualquer dia" icon={Receipt} tone="teal" />
        <Stat label="Total lançado" value={formatBRL(sum)} hint="itens ativos das comandas listadas" icon={CircleDollarSign} tone="violet" />
      </div>

      <Card flush className="reveal">
        {!comandas.length ? (
          <Empty title="Nenhuma comanda no período" icon={ClipboardList}>
            Ajuste o período ou os filtros para ver outros atendimentos. As abertas estão sempre lá em cima.
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
                  <LinkRow key={c.id} href={qs({ id: c.id })} selected={c.id === selected}>
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
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
