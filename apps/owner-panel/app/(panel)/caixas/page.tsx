import { formatBRL, PAYMENT_METHODS, type PaymentMethod } from '@rupbar/core';
import Link from 'next/link';
import { Badge, Card, Empty, PageHeader, PeriodForm } from '@/components/ui';
import { currentEstablishment, periodFrom } from '@/lib/data';

export const metadata = { title: 'Caixas e sangrias' };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default async function CashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const p = periodFrom(params, 30);
  const selected = typeof params.id === 'string' ? params.id : null;
  const [{ data: sessions }, { data: users }, { data: movements }] = await Promise.all([
    sb.from('v_cash_sessions').select('*').eq('establishment_id', est.id).gte('opened_at', p.from).lt('opened_at', p.to).order('number', { ascending: false }),
    sb.from('v_users').select('id, name').eq('establishment_id', est.id),
    sb.from('v_cash_movements').select('*').eq('establishment_id', est.id).gte('created_at', p.from).lt('created_at', p.to).order('created_at', { ascending: false }),
  ]);
  const name = new Map((users ?? []).map((u) => [u.id as string, u.name as string]));
  const sel = (sessions ?? []).find((s) => s.id === selected);
  const summary = sel?.summary as null | { byMethod: Record<string, number>; withdrawals: number; supplies: number; expectedCash: number };

  return (
    <div className="stack-l">
      <PageHeader title="Caixas e sangrias" actions={<PeriodForm de={p.de} ate={p.ate} />} />
      <Card title="Caixas" flush>
        {!sessions?.length ? <Empty title="Nenhum caixa no período" /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Caixa</th><th>Abertura</th><th>Fechamento</th><th className="right">Esperado</th><th className="right">Contado</th><th className="right">Diferença</th></tr></thead><tbody>
            {sessions.map((s) => (
              <tr key={s.id as string} style={s.id === selected ? { background: 'var(--accent-soft)' } : undefined}>
                <td><Link href={`?de=${p.de}&ate=${p.ate}&id=${s.id}`} className="strong">nº {s.number as number}</Link></td>
                <td className="small">{fmt(s.opened_at as string)}<div className="tiny muted">{name.get(s.opened_by as string) ?? '—'}</div></td>
                <td className="small">{s.status === 'open' ? <Badge color="green">Aberto</Badge> : <>{fmt(s.closed_at as string)}<div className="tiny muted">{name.get(s.closed_by as string) ?? '—'}</div></>}</td>
                <td className="right num">{s.expected_cash_cents !== null ? formatBRL(Number(s.expected_cash_cents)) : '—'}</td>
                <td className="right num">{s.counted_cash_cents !== null ? formatBRL(Number(s.counted_cash_cents)) : '—'}</td>
                <td className={`right num strong ${Number(s.difference_cents) < 0 ? 'danger-text' : Number(s.difference_cents) > 0 ? 'warning-text' : ''}`}>{s.difference_cents !== null ? formatBRL(Number(s.difference_cents)) : '—'}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Card>
      {sel && summary && (
        <Card title={`Resumo do caixa nº ${sel.number}`}>
          <div className="grid-3">
            {Object.entries(summary.byMethod).map(([m, v]) => <div key={m} className="stat"><span className="label">{PAYMENT_METHODS[m as PaymentMethod] ?? m}</span><span className="value" style={{ fontSize: 20 }}>{formatBRL(v)}</span></div>)}
            <div className="stat"><span className="label">Sangrias</span><span className="value" style={{ fontSize: 20 }}>{formatBRL(summary.withdrawals)}</span></div>
            <div className="stat"><span className="label">Suprimentos</span><span className="value" style={{ fontSize: 20 }}>{formatBRL(summary.supplies)}</span></div>
          </div>
        </Card>
      )}
      <Card title="Sangrias e suprimentos" flush>
        {!movements?.length ? <Empty title="Nenhuma movimentação no período" /> : (
          <div className="list">
            {movements.map((m) => (
              <div key={m.id as string} className="list-item">
                {m.type === 'withdrawal' ? <Badge color="orange">Sangria</Badge> : <Badge color="blue">Suprimento</Badge>}
                <div className="grow"><div>{m.reason as string}</div><div className="tiny muted">{fmt(m.created_at as string)} · {name.get(m.created_by as string) ?? '—'}{m.has_attachment ? ' · com comprovante (no PC do bar)' : ''}</div></div>
                <span className="num strong">{formatBRL(Number(m.amount_cents))}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
