import type { PaymentMethod } from '@rupbar/core';
import { ArrowLeft, Banknote, CheckCircle2, CreditCard, Megaphone, Plus, Printer, QrCode, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CartLines, MenuPicker, useCart } from '../../components/MenuPicker';
import { PixQr } from '../../components/PixQr';
import { Button, Input, useToast } from '../../components/ui';
import { api, isOfflineError, requestId } from '../../lib/api';
import { formatBRL, PAYMENT_METHODS } from '../../lib/format';
import { useSession } from '../../lib/session';
import '../../styles/quick.css';
import { CashGate } from './MobileCharge';

const METHODS: { m: PaymentMethod; icon: ReactNode }[] = [
  { m: 'pix', icon: <QrCode size={22} /> },
  { m: 'cash', icon: <Banknote size={22} /> },
  { m: 'debit', icon: <CreditCard size={22} /> },
  { m: 'credit', icon: <CreditCard size={22} /> },
];

interface SaleResult {
  orderId: string | null;
  ticketPrinted?: boolean;
  orderNumber: number | null;
  callName: string;
  totalCents: number;
  changeCents: number;
  waitsForPickup: boolean;
}

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
 * Venda rápida no celular do garçom: escolhe os itens, o nome para chamar na
 * TV e recebe na hora (Pix, dinheiro com troco ou cartão). O pedido vai para a
 * produção e o ticket sai na impressora do caixa.
 */
export function MobileQuickSale() {
  const toast = useToast();
  const { can } = useSession();
  const cart = useCart();
  const [step, setStep] = useState<'itens' | 'pagar'>('itens');
  const [name, setName] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('pix');
  const [received, setReceived] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saleKey, setSaleKey] = useState(requestId);
  const [result, setResult] = useState<SaleResult | null>(null);
  const total = cart.total;
  const change = method === 'cash' && received !== null ? Math.max(0, received - total) : 0;

  const reset = () => {
    cart.clear();
    setName('');
    setMethod('pix');
    setReceived(null);
    setResult(null);
    setStep('itens');
    setSaleKey(requestId());
  };

  const finish = async () => {
    if (busy || !cart.lines.length || total <= 0) return;
    setBusy(true);
    try {
      const r = await api.post<SaleResult>('/api/quick-sales', {
        clientRequestId: saleKey,
        customerName: name.trim(),
        items: cart.payload(),
        payments: [{ method, amountCents: total, ...(method === 'cash' && received !== null ? { receivedCents: received } : {}) }],
      });
      (window as unknown as { RupBarAndroid?: { vibrate?: (ms: number) => void } }).RupBarAndroid?.vibrate?.(60);
      setResult(r);
    } catch (e) {
      toast.error(isOfflineError(e) ? 'Sem conexão com o PC. Tente de novo: a venda não será duplicada.' : e);
    } finally {
      setBusy(false);
    }
  };

  if (!can('cash.payment')) {
    return (
      <div className="mobile-body">
        <div className="banner">Você não recebe pagamentos. O dono libera em Funcionários → “Cobra no celular”.</div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="mobile-body">
        <div className="card stack mquick-done pop-in">
          <CheckCircle2 size={56} className="success-text" />
          <h2>Venda concluída</h2>
          {result.waitsForPickup ? (
            <div className="quick-call">
              <Megaphone size={22} />
              <div>
                <div className="small muted">Será chamado na TV como</div>
                <div className="quick-call-name">{result.callName || `Pedido ${result.orderNumber}`}</div>
                {result.orderNumber !== null && <div className="small muted">Pedido nº {result.orderNumber}</div>}
              </div>
            </div>
          ) : <div className="muted">Itens entregues no balcão (sem preparo).</div>}
          {result.changeCents > 0 && <div className="quick-change"><span>Troco</span><strong className="num">{formatBRL(result.changeCents)}</strong></div>}
          <div className={`banner small ${result.ticketPrinted ? 'success' : 'warning'}`}>
            <Printer size={16} style={{ flex: 'none' }} />
            {result.ticketPrinted ? 'Ticket do pedido impresso no caixa.' : 'Ticket não impresso: confira a impressora do caixa.'}
          </div>
          <Button variant="primary" size="large" block icon={<Plus size={18} />} onClick={reset}>Nova venda</Button>
        </div>
      </div>
    );
  }

  if (step === 'pagar') {
    return (
      <div className="mobile-body mcharge" style={{ paddingBottom: 110 }}>
        <div className="waiter-head">
          <Button variant="plain" icon={<ArrowLeft size={22} />} aria-label="Voltar aos itens" onClick={() => setStep('itens')} />
          <div className="grow strong" style={{ fontSize: 17 }}>Venda rápida</div>
        </div>
        <label className="mcharge-amount">
          <span className="small muted">Nome para chamar na TV</span>
          <Input large placeholder="Ex.: Juliana" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="card tight">
          <CartLines cart={cart} />
          <div className="row between mcharge-due"><span>Total</span><strong className="num">{formatBRL(total)}</strong></div>
        </div>
        <CashGate />
        <div className="mcharge-methods" role="radiogroup" aria-label="Forma de pagamento">
          {METHODS.map(({ m, icon }) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} className={`mcharge-method ${method === m ? 'active' : ''}`} onClick={() => { setMethod(m); setReceived(null); }}>
              {icon}<span>{PAYMENT_METHODS[m]}</span>
            </button>
          ))}
        </div>
        {method === 'cash' && total > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <span className="small muted">Recebido em dinheiro</span>
            <div className="row wrap">
              {bills(total).map((v) => <button key={v} type="button" className={`chip ${received === v ? 'active' : ''}`} onClick={() => setReceived(v)}>{formatBRL(v)}</button>)}
            </div>
            {change > 0 && <div className="quick-change"><span>Troco</span><strong className="num">{formatBRL(change)}</strong></div>}
          </div>
        )}
        {method === 'pix' && total > 0 && <PixQr amountCents={total} size={220} />}
        <Button variant="primary" size="large" block loading={busy} disabled={!cart.lines.length || total <= 0 || (method === 'cash' && received !== null && received < total)} icon={<CheckCircle2 size={20} />} onClick={() => void finish()}>
          Recebi {formatBRL(total)}
        </Button>
      </div>
    );
  }

  return (
    <div className="mobile-body" style={{ paddingBottom: 110 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="icon-chip"><Zap size={18} /></span>
        <div>
          <strong>Venda rápida</strong>
          <div className="tiny muted">Cliente paga na hora e é chamado pelo nome na TV.</div>
        </div>
      </div>
      <MenuPicker cart={cart} compact />
      {cart.lines.length > 0 && (
        <div className="cart-bar glass pop-in">
          <div className="grow">
            <div className="small" style={{ opacity: 0.75 }}>{cart.count} {cart.count === 1 ? 'item' : 'itens'}</div>
            <div className="strong num" style={{ fontSize: 18 }}>{formatBRL(total)}</div>
          </div>
          <Button variant="primary" size="large" icon={<CheckCircle2 size={18} />} onClick={() => setStep('pagar')}>Cobrar</Button>
        </div>
      )}
    </div>
  );
}
