import { cashClosing, formatBRL, PAYMENT_METHODS, type CashClosingSummary, type PaymentMethod } from '@rupbar/core';
import { ArrowDownToLine, ArrowUpFromLine, Banknote, History, Lock, LockOpen, Paperclip, Scale, Vault, Wallet, X } from 'lucide-react';
import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { CommandFeed } from '@/components/CommandFeed';
import { LinkRow } from '@/components/LinkRow';
import { ScrollHere } from '@/components/ScrollHere';
import { Badge, Card, Empty, PageHeader, PeriodForm, Stat, stagger } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';
import { fmtShort } from '@/lib/format';
import { closeCash, openCash } from '../acoes';

export const metadata = { title: 'Caixas e sangrias' };

export default async function CashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 30);
  const selected = typeof params.id === 'string' ? params.id : null;
  const [{ data: sessions }, { data: users }, { data: movements }, { data: openRows }] = await Promise.all([
    sb.from('v_cash_sessions').select('*').eq('establishment_id', est.id).gte('opened_at', p.from).lt('opened_at', p.to).order('number', { ascending: false }),
    sb.from('v_users').select('id, name').eq('establishment_id', est.id),
    sb.from('v_cash_movements').select('*').eq('establishment_id', est.id).gte('created_at', p.from).lt('created_at', p.to).order('created_at', { ascending: false }),
    // Caixa aberto agora (de qualquer dia), para fechar pelo painel.
    sb.from('v_cash_sessions').select('*').eq('establishment_id', est.id).eq('status', 'open').order('opened_at', { ascending: false }).limit(1),
  ]);
  const name = new Map((users ?? []).map((u) => [u.id as string, u.name as string]));
  const openSession = openRows?.[0] ?? null;
  // Caixas ainda abertos: o resumo é calculado agora, como o PC faz no fechamento.
  const openIds = [...new Set([...(openSession ? [openSession.id as string] : []), ...(sessions ?? []).filter((s) => s.status === 'open').map((s) => s.id as string)])];
  const [{ data: openPays }, { data: openMoves }] = openIds.length
    ? await Promise.all([
        sb.from('v_payments').select('cash_session_id, method, amount_cents').eq('establishment_id', est.id).eq('status', 'active').in('cash_session_id', openIds),
        sb.from('v_cash_movements').select('*').eq('establishment_id', est.id).in('session_id', openIds),
      ])
    : [{ data: [] }, { data: [] }];
  const live = (s: Record<string, unknown>): CashClosingSummary => {
    const moves = (openMoves ?? []).filter((m) => m.session_id === s.id && m.status !== 'voided');
    return cashClosing({
      openingBalance: Number(s.opening_balance_cents ?? 0),
      payments: (openPays ?? []).filter((x) => x.cash_session_id === s.id).map((x) => ({ method: x.method as PaymentMethod, amount: Number(x.amount_cents) })),
      withdrawals: moves.filter((m) => m.type === 'withdrawal').map((m) => Number(m.amount_cents)),
      supplies: moves.filter((m) => m.type === 'supply').map((m) => Number(m.amount_cents)),
      countedCash: null,
    });
  };
  const now = openSession ? live(openSession) : null;
  const sel = (sessions ?? []).find((s) => s.id === selected);
  const selOpen = sel?.status === 'open';
  const summary = sel ? (selOpen ? live(sel) : (sel.summary as null | Pick<CashClosingSummary, 'byMethod' | 'withdrawals' | 'supplies' | 'expectedCash'>)) : null;
  const valid = (movements ?? []).filter((m) => m.status !== 'voided');
  const withdrawals = valid.filter((m) => m.type === 'withdrawal').reduce((a, m) => a + Number(m.amount_cents), 0);
  const supplies = valid.filter((m) => m.type !== 'withdrawal').reduce((a, m) => a + Number(m.amount_cents), 0);
  const diff = (sessions ?? []).reduce((a, s) => a + (s.difference_cents !== null ? Number(s.difference_cents) : 0), 0);

  return (
    <div className="stack-l">
      <PageHeader title="Caixas e sangrias" eyebrow="Financeiro" icon={Wallet} subtitle="Abra e feche o caixa daqui; aberturas, fechamentos e movimentações de dinheiro." />

      <div className="split-form">
        {openSession && now ? (
          <Card title={`Caixa nº ${openSession.number as number} aberto`} subtitle={`Desde ${fmtShort(openSession.opened_at as string)} · ${name.get(openSession.opened_by as string) ?? '—'}`} icon={Lock} tone="amber">
            <div className="drawer-now">
              <span className="now-label">Dinheiro na gaveta agora</span>
              <span className="now-value num">{formatBRL(now.expectedCash)}</span>
              <span className="tiny muted">
                troco {formatBRL(Number(openSession.opening_balance_cents ?? 0))} + dinheiro recebido {formatBRL(now.byMethod.cash ?? 0)}
                {now.supplies ? ` + suprimentos ${formatBRL(now.supplies)}` : ''}
                {now.withdrawals ? ` − sangrias ${formatBRL(now.withdrawals)}` : ''}
              </span>
            </div>
            <CashBreakdown summary={now} />
            <ActionForm action={closeCash} submit="Fechar caixa" icon={<Lock size={17} aria-hidden="true" />} variant="danger" block confirm="Fechar o caixa agora? Quem estiver usando o PC do bar não vai mais poder receber até abrir de novo.">
              <div className="field">
                <label htmlFor="countedCash">Dinheiro contado na gaveta (R$)</label>
                <input id="countedCash" name="countedCash" className="input" inputMode="decimal" placeholder={`Esperado: ${formatBRL(now.expectedCash)}`} required />
              </div>
              <div className="field">
                <label htmlFor="notes">Observação</label>
                <input id="notes" name="notes" className="input" maxLength={400} placeholder="Opcional" />
              </div>
            </ActionForm>
          </Card>
        ) : (
          <Card title="Abrir caixa" subtitle="Nenhum caixa aberto agora" icon={LockOpen} tone="teal">
            <ActionForm action={openCash} submit="Abrir caixa" icon={<LockOpen size={17} aria-hidden="true" />} block>
              <div className="field">
                <label htmlFor="openingBalance">Troco inicial na gaveta (R$)</label>
                <input id="openingBalance" name="openingBalance" className="input" inputMode="decimal" placeholder="Ex.: 100,00" />
              </div>
            </ActionForm>
          </Card>
        )}
        <CommandFeed types={['cash.open', 'cash.close']} path="/caixas" />
      </div>

      <div className="page-header section-head">
        <div className="page-heading">
          <span className="page-icon sm" aria-hidden="true">
            <History size={18} strokeWidth={2} />
          </span>
          <div className="grow">
            <h2>Histórico</h2>
            <p className="subtitle">Caixas, sangrias e suprimentos do período</p>
          </div>
        </div>
        <div className="page-actions">
          <PeriodForm de={p.de} ate={p.ate} />
        </div>
      </div>

      <div className="grid-3 stagger">
        <Stat label="Sangrias" value={formatBRL(withdrawals)} hint="retiradas de dinheiro no período" icon={ArrowUpFromLine} tone="amber" />
        <Stat label="Suprimentos" value={formatBRL(supplies)} hint="reforços de troco no período" icon={ArrowDownToLine} tone="teal" />
        <Stat
          label="Diferença acumulada"
          value={<span className={diff < 0 ? 'danger-text' : diff > 0 ? 'warning-text' : ''}>{formatBRL(diff)}</span>}
          hint={`${sessions?.length ?? 0} caixa(s) no período`}
          icon={Scale}
          tone={diff < 0 ? 'rose' : 'violet'}
        />
      </div>

      <Card title="Caixas" subtitle="Toque em um caixa para ver o resumo" icon={Vault} flush className="reveal" style={stagger(3)}>
        {!sessions?.length ? (
          <Empty title="Nenhum caixa no período" icon={Vault}>
            Os caixas abertos e fechados no PC do bar aparecem aqui.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Caixa</th>
                  <th scope="col">Abertura</th>
                  <th scope="col">Fechamento</th>
                  <th scope="col" className="right">Esperado</th>
                  <th scope="col" className="right">Contado</th>
                  <th scope="col" className="right">Diferença</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <LinkRow key={s.id as string} href={`?de=${p.de}&ate=${p.ate}&id=${s.id}`} selected={s.id === selected}>
                    <td>
                      <Link href={`?de=${p.de}&ate=${p.ate}&id=${s.id}`} className="row-link strong" scroll={false} aria-current={s.id === selected ? 'true' : undefined}>
                        nº {s.number as number}
                      </Link>
                    </td>
                    <td className="small">
                      <span className="num">{fmtShort(s.opened_at as string)}</span>
                      <div className="tiny muted">{name.get(s.opened_by as string) ?? '—'}</div>
                    </td>
                    <td className="small">
                      {s.status === 'open' ? (
                        // O PC só tem um caixa aberto; um mais antigo ainda "aberto" ficou sem o fechamento.
                        s.id === openSession?.id ? (
                          <Badge color="green" dot pulse>
                            Aberto
                          </Badge>
                        ) : (
                          <Badge color="orange">Sem fechamento</Badge>
                        )
                      ) : (
                        <>
                          <span className="num">{fmtShort(s.closed_at as string)}</span>
                          <div className="tiny muted">{name.get(s.closed_by as string) ?? '—'}</div>
                        </>
                      )}
                    </td>
                    <td className="right num">
                      {s.status === 'open' ? (
                        <>
                          {formatBRL(live(s).expectedCash)}
                          <div className="tiny muted">até agora</div>
                        </>
                      ) : s.expected_cash_cents !== null ? (
                        formatBRL(Number(s.expected_cash_cents))
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="right num">{s.counted_cash_cents !== null ? formatBRL(Number(s.counted_cash_cents)) : '—'}</td>
                    <td className={`right num strong ${Number(s.difference_cents) < 0 ? 'danger-text' : Number(s.difference_cents) > 0 ? 'warning-text' : ''}`}>
                      {s.difference_cents !== null ? formatBRL(Number(s.difference_cents)) : '—'}
                    </td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {sel && summary && (
        <Card
          key={sel.id as string}
          title={`Resumo do caixa nº ${sel.number}`}
          subtitle={selOpen ? 'Caixa aberto: valores até agora' : 'Recebimentos por forma de pagamento e movimentações'}
          icon={Banknote}
          tone="teal"
          className="detail-card"
          actions={
            <Link href={`?de=${p.de}&ate=${p.ate}`} className="btn ghost icon" aria-label="Fechar resumo" scroll={false}>
              <X size={18} aria-hidden="true" />
            </Link>
          }
        >
          <ScrollHere />
          <CashBreakdown summary={summary} drawer={selOpen ? 'Na gaveta agora' : 'Esperado na gaveta'} />
        </Card>
      )}

      <Card title="Sangrias e suprimentos" subtitle="Movimentações de dinheiro registradas no caixa" icon={Banknote} tone="amber" flush className="reveal" style={stagger(4)}>
        {!movements?.length ? (
          <Empty title="Nenhuma movimentação no período" icon={Banknote} />
        ) : (
          <ul className="list scroll-list tall">
            {movements.map((m) => {
              const out = m.type === 'withdrawal';
              const voided = m.status === 'voided';
              return (
                <li key={m.id as string} className={`list-item${voided ? ' voided' : ''}`}>
                  <span className={`icon-chip ${out ? 'amber' : 'teal'} sm`} aria-hidden="true">
                    {out ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />}
                  </span>
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      {out ? <Badge color="orange">Sangria</Badge> : <Badge color="blue">Suprimento</Badge>}
                      {voided && <Badge color="gray">Anulada</Badge>}
                      <span className="ellipsis">{m.reason as string}</span>
                    </div>
                    <div className="tiny muted">
                      {fmtShort(m.created_at as string)} · {name.get(m.created_by as string) ?? '—'}
                      {m.has_attachment ? (
                        <>
                          {' · '}
                          <Paperclip size={11} aria-hidden="true" /> com comprovante (no PC do bar)
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="num strong">{formatBRL(Number(m.amount_cents))}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Recebido por forma de pagamento, sangrias e suprimentos (e, no resumo, o esperado na gaveta). */
function CashBreakdown({ summary, drawer }: { summary: Pick<CashClosingSummary, 'byMethod' | 'withdrawals' | 'supplies' | 'expectedCash'>; drawer?: string }) {
  const methods = Object.entries(summary.byMethod).filter(([, v]) => v);
  const total = methods.reduce((a, [, v]) => a + v, 0);
  return (
    <div className="mini-stats stagger">
      {drawer && (
        <div className="mini-stat accent">
          <span className="mini-label">{drawer}</span>
          <span className="mini-value">{formatBRL(summary.expectedCash)}</span>
        </div>
      )}
      <div className="mini-stat">
        <span className="mini-label">Recebido no caixa</span>
        <span className="mini-value">{formatBRL(total)}</span>
      </div>
      {methods.map(([m, v]) => (
        <div key={m} className="mini-stat">
          <span className="mini-label">{PAYMENT_METHODS[m as PaymentMethod] ?? m}</span>
          <span className="mini-value">{formatBRL(v)}</span>
        </div>
      ))}
      <div className="mini-stat">
        <span className="mini-label">Sangrias</span>
        <span className="mini-value">{formatBRL(summary.withdrawals)}</span>
      </div>
      <div className="mini-stat">
        <span className="mini-label">Suprimentos</span>
        <span className="mini-value">{formatBRL(summary.supplies)}</span>
      </div>
    </div>
  );
}
