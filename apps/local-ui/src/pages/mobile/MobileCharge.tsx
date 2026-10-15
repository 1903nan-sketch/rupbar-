import type { PaymentMethod } from '@rupbar/core';
import { Banknote, CheckCircle2, CreditCard, Printer, QrCode } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { PixQr } from '../../components/PixQr';
import { Button, MoneyInput, useToast } from '../../components/ui';
import { api, requestId } from '../../lib/api';
import { formatBRL, PAYMENT_METHODS } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { ComandaDetail } from '../ComandaDetail';

const METHODS: { m: PaymentMethod; icon: ReactNode }[] = [
  { m: 'pix', icon: <QrCode size={22} /> },
  { m: 'cash', icon: <Banknote size={22} /> },
  { m: 'debit', icon: <CreditCard size={22} /> },
  { m: 'credit', icon: <CreditCard size={22} /> },
];

/** Notas sugeridas para o valor recebido em dinheiro. */
function bills(total: number): number[] {
  const out = new Set<number>([total]);
  for (const b of [1000, 2000, 5000, 10000, 20000]) {
    const v = Math.ceil(total / b) * b;
    if (v > total) out.add(v);
    if (out.size >= 4) break;
  }
  return [...out];
}

/**
 * Cobrar no celular: escolhe a forma, confirma e, quitada a conta, encerra a
 * comanda. Sem permissão para receber, o garçom só pede a conta impressa.
 */
export function MobileCharge({ comanda, onChanged, onClosed }: { comanda: ComandaDetail; onChanged: () => void; onClosed: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const [method, setMethod] = useState<PaymentMethod>('pix');
  const [amount, setAmount] = useState<number | null>(comanda.remaining);
  const [received, setReceived] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(requestId);
  const active = comanda.items.filter((i) => i.status === 'active');
  const value = Math.min(amount ?? 0, comanda.remaining);
  const change = method === 'cash' && received !== null ? Math.max(0, received - value) : 0;

  const printBill = async () => {
    try {
      await api.post(`/api/comandas/${comanda.id}/print`);
      toast.success('Conta enviada para a impressora');
    } catch (e) {
      toast.error(e);
    }
  };

  const pay = async () => {
    if (value <= 0 || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ changeCents?: number; comanda: ComandaDetail }>('/api/payments', {
        comandaId: comanda.id, method, amountCents: value, receivedCents: method === 'cash' && received ? received : undefined, clientRequestId: key,
      });
      setKey(requestId());
      (window as unknown as { RupBarAndroid?: { vibrate?: (ms: number) => void } }).RupBarAndroid?.vibrate?.(60);
      if (r.comanda.remaining <= 0 && can('comandas.close')) {
        await api.post(`/api/comandas/${comanda.id}/close`, { expectedVersion: r.comanda.version });
        toast.success(r.changeCents ? `Pago e encerrada. Troco: ${formatBRL(r.changeCents)}` : 'Pago e comanda encerrada');
        onClosed();
        return;
      }
      toast.success(r.changeCents ? `Pagamento registrado. Troco: ${formatBRL(r.changeCents)}` : 'Pagamento registrado');
      setAmount(r.comanda.remaining);
      setReceived(null);
      onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcharge">
      <div className="mcharge-total card">
        <div className="mcharge-lines">
          {active.map((i) => (
            <div key={i.id} className="row between small">
              <span className="ellipsis">{i.quantity}× {i.name}{i.presentationName !== 'Unidade' && ` · ${i.presentationName}`}</span>
              <span className="num">{formatBRL(i.totalCents)}</span>
            </div>
          ))}
          {active.length === 0 && <div className="small muted">Nenhum item lançado.</div>}
        </div>
        {comanda.serviceFee > 0 && <div className="row between small muted"><span>Taxa de serviço</span><span className="num">{formatBRL(comanda.serviceFee)}</span></div>}
        {comanda.paid > 0 && <div className="row between small muted"><span>Já pago</span><span className="num">{formatBRL(comanda.paid)}</span></div>}
        <div className="row between mcharge-due"><span>{comanda.paid > 0 ? 'Falta' : 'Total'}</span><strong className="num">{formatBRL(comanda.remaining)}</strong></div>
      </div>

      {!can('cash.payment') ? (
        <div className="stack">
          <div className="banner">Você não recebe pagamentos. Peça a conta impressa e leve o cliente ao caixa.</div>
          <Button size="large" block icon={<Printer size={18} />} onClick={printBill}>Imprimir conta</Button>
        </div>
      ) : comanda.remaining <= 0 ? (
        <div className="stack">
          <div className="banner success">Conta paga.</div>
          {can('comandas.close') && active.length > 0 && (
            <Button variant="success" size="large" block icon={<CheckCircle2 size={18} />} onClick={async () => {
              try { await api.post(`/api/comandas/${comanda.id}/close`, { expectedVersion: comanda.version }); toast.success('Comanda encerrada'); onClosed(); } catch (e) { toast.error(e); }
            }}>Encerrar comanda</Button>
          )}
        </div>
      ) : (
        <div className="stack">
          <div className="mcharge-methods" role="radiogroup" aria-label="Forma de pagamento">
            {METHODS.map(({ m, icon }) => (
              <button key={m} type="button" role="radio" aria-checked={method === m} className={`mcharge-method ${method === m ? 'active' : ''}`} onClick={() => { setMethod(m); setReceived(null); }}>
                {icon}<span>{PAYMENT_METHODS[m]}</span>
              </button>
            ))}
          </div>
          <label className="mcharge-amount">
            <span className="small muted">Valor (dá para cobrar uma parte)</span>
            <MoneyInput large value={amount} onChange={setAmount} />
          </label>
          {method === 'cash' && value > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <span className="small muted">Recebido em dinheiro</span>
              <div className="row wrap">
                {bills(value).map((v) => <button key={v} type="button" className={`chip ${received === v ? 'active' : ''}`} onClick={() => setReceived(v)}>{formatBRL(v)}</button>)}
              </div>
              {change > 0 && <div className="quick-change"><span>Troco</span><strong className="num">{formatBRL(change)}</strong></div>}
            </div>
          )}
          {method === 'pix' && value > 0 && <PixQr amountCents={value} comandaId={comanda.id} size={220} />}
          <Button variant="primary" size="large" block loading={busy} disabled={value <= 0} icon={<CheckCircle2 size={20} />} onClick={pay}>
            Recebi {formatBRL(value)}
          </Button>
          <Button variant="plain" block icon={<Printer size={16} />} onClick={printBill}>Imprimir conta</Button>
        </div>
      )}
    </div>
  );
}
