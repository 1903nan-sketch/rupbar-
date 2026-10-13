import { ShieldCheck } from 'lucide-react';
import { Card, Empty, ErrorBox, Loading, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime, formatBRL } from '../../lib/format';
import { useLoad } from '../../lib/hooks';

interface Correction {
  id: string;
  user_name: string | null;
  action: string;
  entity: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

const LABEL: Record<string, string> = {
  'admin.comanda_reopened': 'Comanda reaberta',
  'admin.comanda_deleted': 'Comanda excluída',
  'admin.item_edited': 'Item corrigido',
  'admin.item_deleted': 'Item excluído',
  'admin.payment_edited': 'Pagamento corrigido',
  'admin.payment_deleted': 'Pagamento excluído',
  'admin.cash_movement_edited': 'Sangria/suprimento corrigido',
  'admin.cash_movement_deleted': 'Sangria/suprimento excluído',
  'admin.cash_session_edited': 'Caixa corrigido',
  'admin.cash_session_reopened': 'Caixa reaberto',
  'admin.purchase_canceled': 'Entrada de mercadoria excluída',
  'admin.stock_movement_reversed': 'Movimentação de estoque desfeita',
  'admin.loss_deleted': 'Perda excluída',
  'admin.hookah_session_deleted': 'Locação de narguilé excluída',
};

/** Resumo curto do que mudou (valores em centavos viram R$). */
function detail(d: Record<string, unknown> | null): string {
  if (!d) return '';
  const money = (v: unknown) => (typeof v === 'number' ? formatBRL(v) : String(v ?? '—'));
  const parts: string[] = [];
  if (typeof d.product === 'string') parts.push(d.product);
  if (typeof d.number === 'number') parts.push(`nº ${d.number}`);
  const from = d.from as Record<string, unknown> | undefined;
  const to = d.to as Record<string, unknown> | undefined;
  if (from && to) {
    for (const k of Object.keys(to)) {
      if (to[k] === undefined || from[k] === to[k]) continue;
      const isMoney = /cents|Cents|opening|counted/.test(k);
      parts.push(`${isMoney ? money(from[k]) : String(from[k] ?? '—')} → ${isMoney ? money(to[k]) : String(to[k] ?? '—')}`);
    }
  }
  if (typeof d.amountCents === 'number') parts.push(formatBRL(d.amountCents));
  if (typeof d.totalCents === 'number') parts.push(formatBRL(d.totalCents));
  return parts.join(' · ');
}

/** Histórico de correções feitas pela conta mestre. */
export function CorrectionsHistory() {
  const { data, error, reload } = useLoad(() => api.get<Correction[]>('/api/admin/history?limit=500'));
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack-l">
      <PageHeader title="Histórico de correções" subtitle="Tudo o que o proprietário editou ou excluiu, com motivo, data e quem fez. Nada é apagado do banco." />
      {data.length === 0 ? (
        <Card><Empty icon={<ShieldCheck size={36} />} title="Nenhuma correção ainda">Correções de comandas, pagamentos, caixa, estoque e perdas aparecem aqui.</Empty></Card>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Quando</th><th>O quê</th><th>Detalhes</th><th>Motivo</th><th>Quem</th></tr></thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id}>
                    <td className="small nowrap">{fmtDateTime(c.created_at)}</td>
                    <td className="strong">{LABEL[c.action] ?? c.action}</td>
                    <td className="small">{detail(c.data)}</td>
                    <td className="small muted">{String(c.data?.reason ?? '')}</td>
                    <td className="small">{c.user_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
