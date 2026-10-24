import { comandaLabel, formatBRL } from '@rupbar/core';
import { BadgePercent, Check, X } from 'lucide-react';
import { decideDiscount } from '@/app/(panel)/acoes';
import { ActionForm } from './ActionForm';
import { DiscountWatch } from './DiscountWatch';
import { Card } from './ui';
import { currentEstablishment } from '@/lib/data';
import { fmtShort } from '@/lib/format';

interface Pending {
  id: string;
  comanda_id: string;
  requested_by_name: string;
  discount_cents: number;
  reason: string;
  total_cents: number;
  total_after_cents: number;
  created_at: string;
}

/**
 * Pedidos de desconto dos funcionários esperando o proprietário. Aparece no
 * topo de todas as páginas; aceitar ou recusar vira um comando para o PC.
 */
export async function DiscountInbox() {
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const { data } = await sb.from('v_discount_requests').select('*').eq('establishment_id', est.id).eq('status', 'pending').order('created_at').limit(20);
  const rows = (data ?? []) as Pending[];
  const { data: comandas } = rows.length
    ? await sb.from('v_comandas').select('id, number, card_number, kind, customer_name, table_label, status').eq('establishment_id', est.id).in('id', rows.map((r) => r.comanda_id))
    : { data: [] };
  const byId = new Map((comandas ?? []).map((c) => [c.id as string, c]));
  // Comanda que já fechou: o PC cancela o pedido sozinho; não pede resposta.
  const pending = rows.filter((r) => byId.get(r.comanda_id)?.status === 'open');
  return (
    <>
      <DiscountWatch establishmentId={est.id} ids={rows.map((r) => r.id)} count={pending.length} />
      {pending.length > 0 && (
        <Card
          title={pending.length === 1 ? 'Pedido de desconto' : `Pedidos de desconto · ${pending.length}`}
          subtitle="Um funcionário pediu desconto no PC do bar. Só você aprova."
          icon={BadgePercent}
          tone="amber"
          className="discount-inbox"
          flush
        >
          <ul className="list">
            {pending.map((r) => {
              const c = byId.get(r.comanda_id)!;
              const label = comandaLabel({ number: Number(c.number), cardNumber: c.card_number === null ? null : Number(c.card_number), kind: String(c.kind) });
              const who = [c.customer_name, c.table_label ? `mesa ${c.table_label}` : null].filter(Boolean).join(' · ');
              const desc = `desconto de ${formatBRL(Number(r.discount_cents))} na ${label}`;
              return (
                <li key={r.id} className="discount-request">
                  <div className="discount-request-head">
                    <strong>{label}</strong>
                    {who && <span className="small muted ellipsis">{who}</span>}
                  </div>
                  <p className="small">
                    <strong>{r.requested_by_name}</strong> pediu · {fmtShort(r.created_at)}
                    <br />
                    Motivo: {r.reason}
                  </p>
                  <dl className="discount-numbers">
                    <div>
                      <dt>Valor da comanda</dt>
                      <dd className="num">{formatBRL(Number(r.total_cents))}</dd>
                    </div>
                    <div className="discount-minus">
                      <dt>Desconto</dt>
                      <dd className="num">− {formatBRL(Number(r.discount_cents))}</dd>
                    </div>
                    <div className="discount-final">
                      <dt>Vai ficar</dt>
                      <dd className="num">{formatBRL(Number(r.total_after_cents))}</dd>
                    </div>
                  </dl>
                  <div className="discount-actions">
                    <ActionForm action={decideDiscount} submit="Recusar" pending="Recusando…" icon={<X size={16} aria-hidden="true" />} variant="ghost" reset={false}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <input type="hidden" name="decision" value="reject" />
                      <input type="hidden" name="label" value={desc} />
                    </ActionForm>
                    <ActionForm action={decideDiscount} submit="Aceitar desconto" pending="Aceitando…" icon={<Check size={16} aria-hidden="true" />} reset={false}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <input type="hidden" name="decision" value="approve" />
                      <input type="hidden" name="label" value={desc} />
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
