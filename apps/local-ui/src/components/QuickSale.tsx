import type { PaymentMethod } from '@rupbar/core';
import { Banknote, CheckCircle2, CreditCard, Megaphone, Plus, Printer, QrCode, ShoppingBag, Trash2, Wallet, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, isOfflineError, requestId } from '../lib/api';
import { formatBRL, PAYMENT_METHODS } from '../lib/format';
import '../styles/quick.css';
import { CartLines, MenuPicker, useCart } from './MenuPicker';
import { PixQr } from './PixQr';
import { usePrintSwitches } from './PrintSwitches';
import { Button, Input, MoneyInput, Switch, useToast } from './ui';

interface SaleResult {
  comandaId: string;
  orderId: string | null;
  /** Ticket do pedido foi para a impressora do caixa. */
  ticketPrinted?: boolean;
  saleNumber: number;
  orderNumber: number | null;
  customerName: string;
  callName: string;
  totalCents: number;
  changeCents: number;
  waitsForPickup: boolean;
}
interface PayLine {
  method: PaymentMethod;
  amountCents: number | null;
  receivedCents: number | null;
}

const METHOD_ICON: Record<PaymentMethod, ReactNode> = {
  cash: <Banknote size={18} />,
  pix: <QrCode size={18} />,
  debit: <CreditCard size={18} />,
  credit: <CreditCard size={18} />,
  voucher: <Wallet size={18} />,
  other: <Wallet size={18} />,
};
const MAIN_METHODS: PaymentMethod[] = ['cash', 'pix', 'debit', 'credit'];

/** Notas para sugerir o valor recebido em dinheiro (próximas cédulas acima do total). */
function cashSuggestions(total: number): number[] {
  const bills = [500, 1000, 2000, 5000, 10000, 20000];
  const out = new Set<number>([total]);
  for (const b of bills) {
    const v = Math.ceil(total / b) * b;
    if (v > total) out.add(v);
    if (out.size >= 4) break;
  }
  return [...out];
}

/**
 * Venda rápida (balcão): escolhe os itens, o nome para chamar e o pagamento.
 * O pedido vai para a produção e a TV chama o cliente pelo nome.
 */
export function QuickSale({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const cart = useCart();
  const [name, setName] = useState('');
  const [payments, setPayments] = useState<PayLine[]>([{ method: 'pix', amountCents: null, receivedCents: null }]);
  // Ticket e comprovante: ficam como foram deixados para as próximas vendas (gravado no PC).
  const { sw: printSw, set: setPrintSw } = usePrintSwitches();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaleResult | null>(null);
  const saleKey = useRef<string | null>(null);

  const total = cart.total;
  // Uma forma de pagamento: o valor é sempre o total. Várias: a última completa o que falta.
  const lines = useMemo(() => {
    if (payments.length === 1) return [{ ...payments[0]!, amountCents: total }];
    const others = payments.slice(0, -1).reduce((a, p) => a + (p.amountCents ?? 0), 0);
    return payments.map((p, i) => (i === payments.length - 1 ? { ...p, amountCents: Math.max(0, total - others) } : p));
  }, [payments, total]);
  const cashLine = lines.find((l) => l.method === 'cash');
  const change = cashLine && cashLine.receivedCents !== null ? Math.max(0, cashLine.receivedCents - (cashLine.amountCents ?? 0)) : 0;
  const paidSum = lines.reduce((a, l) => a + (l.amountCents ?? 0), 0);
  const ready = cart.lines.length > 0 && total > 0 && paidSum === total && lines.every((l) => (l.amountCents ?? 0) > 0)
    && (!cashLine || cashLine.receivedCents === null || cashLine.receivedCents >= (cashLine.amountCents ?? 0));

  useEffect(() => {
    saleKey.current = null; // conteúdo mudou: novo identificador de envio
  }, [cart.lines, name, payments]);

  const setLine = (i: number, patch: Partial<PayLine>) => setPayments((p) => p.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const finish = async () => {
    if (!ready || busy) return;
    saleKey.current ??= requestId();
    setBusy(true);
    try {
      const r = await api.post<SaleResult>('/api/quick-sales', {
        clientRequestId: saleKey.current,
        customerName: name.trim(),
        items: cart.payload(),
        payments: lines.map((l) => ({
          method: l.method,
          amountCents: l.amountCents,
          ...(l.method === 'cash' && l.receivedCents !== null ? { receivedCents: l.receivedCents } : {}),
        })),
        ...(printSw ? { printReceipt: printSw.quickReceipt } : {}),
      });
      setResult(r);
    } catch (e) {
      toast.error(isOfflineError(e) ? 'Sem conexão com o PC. Tente de novo — a venda não será duplicada.' : e);
    } finally {
      setBusy(false);
    }
  };

  const reprintTicket = async () => {
    if (!result?.orderId) return;
    try {
      await api.post(`/api/orders/${result.orderId}/ticket`);
      toast.success('2ª via do ticket enviada para a impressora do caixa');
    } catch (e) {
      toast.error(e);
    }
  };

  const reset = () => {
    cart.clear();
    setName('');
    setPayments([{ method: 'pix', amountCents: null, receivedCents: null }]);
    setResult(null);
    saleKey.current = null;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc com a escolha do drink aberta fecha só a escolha.
      if (e.key === 'Escape' && !document.querySelector('.option-chooser')) onClose();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (result) reset();
        else void finish();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="overlay quick-overlay" role="dialog" aria-modal="true" aria-label="Venda rápida">
      <div className="quick-sale modal">
        <header className="quick-head">
          <div className="row">
            <span className="icon-chip"><Zap size={20} /></span>
            <div>
              <h2>Venda rápida</h2>
              <div className="small muted">Cliente paga na hora e é chamado pelo nome na TV.</div>
            </div>
          </div>
          <Button variant="plain" icon={<X size={20} />} aria-label="Fechar" onClick={onClose} />
        </header>

        {result ? (
          <div className="quick-done pop-in">
            <CheckCircle2 size={64} className="success-text" />
            <h2>Venda concluída</h2>
            {result.waitsForPickup ? (
              <div className="quick-call">
                <Megaphone size={22} />
                <div>
                  <div className="small muted">Avise o cliente: será chamado na TV como</div>
                  <div className="quick-call-name">{result.callName || `Pedido ${result.orderNumber}`}</div>
                  {result.orderNumber !== null && <div className="small muted">Pedido nº {result.orderNumber}</div>}
                </div>
              </div>
            ) : (
              <div className="muted">Itens entregues no balcão (sem preparo).</div>
            )}
            <div className="quick-done-values">
              <div><span className="muted small">Total</span><strong className="num">{formatBRL(result.totalCents)}</strong></div>
              {result.changeCents > 0 && <div className="quick-change"><span className="small">Troco</span><strong className="num">{formatBRL(result.changeCents)}</strong></div>}
            </div>
            <div className={`banner small ${result.ticketPrinted ? 'success' : 'warning'}`} style={{ textAlign: 'left' }}>
              <Printer size={18} style={{ flex: 'none' }} />
              <span className="grow">
                {result.ticketPrinted
                  ? 'Ticket do pedido impresso no caixa: entregue ao cliente para retirar no bar.'
                  : 'O ticket não foi impresso: marque uma impressora como "Impressora do caixa" em Configurações → Impressoras.'}
              </span>
              {result.orderId && <Button size="small" variant="plain" onClick={() => void reprintTicket()}>{result.ticketPrinted ? '2ª via' : 'Imprimir'}</Button>}
            </div>
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button onClick={onClose}>Fechar</Button>
              <Button variant="primary" size="large" icon={<Plus size={18} />} onClick={reset} autoFocus>Nova venda</Button>
            </div>
          </div>
        ) : (
          <div className="quick-body">
            <section className="quick-menu">
              <MenuPicker cart={cart} autoFocus />
            </section>
            <aside className="quick-side">
              <label className="quick-name">
                <span className="small strong">Nome para chamar na TV</span>
                <Input large placeholder="Ex.: Juliana" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="section-label row between"><span><ShoppingBag size={13} /> Itens</span><span className="num">{cart.count}</span></div>
              <CartLines cart={cart} />
              <div className="quick-total"><span>Total</span><strong className="num">{formatBRL(total)}</strong></div>

              <div className="section-label">Pagamento</div>
              {payments.map((p, i) => {
                const line = lines[i]!;
                const last = i === payments.length - 1;
                return (
                  <div key={i} className="quick-pay">
                    <div className="quick-methods" role="radiogroup" aria-label="Forma de pagamento">
                      {MAIN_METHODS.map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={p.method === m} className={`quick-method ${p.method === m ? 'active' : ''}`} onClick={() => setLine(i, { method: m, receivedCents: null })}>
                          {METHOD_ICON[m]}<span>{PAYMENT_METHODS[m]}</span>
                        </button>
                      ))}
                    </div>
                    {payments.length > 1 && (
                      <div className="row">
                        {last ? (
                          <div className="grow small muted">Restante: <strong className="num">{formatBRL(line.amountCents ?? 0)}</strong></div>
                        ) : (
                          <div className="grow"><MoneyInput value={p.amountCents} onChange={(v) => setLine(i, { amountCents: v })} placeholder="Valor" /></div>
                        )}
                        <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Remover forma" onClick={() => setPayments((x) => x.filter((_, n) => n !== i))} />
                      </div>
                    )}
                    {p.method === 'pix' && (line.amountCents ?? 0) > 0 && <PixQr amountCents={line.amountCents ?? 0} />}
                    {p.method === 'cash' && (line.amountCents ?? 0) > 0 && (
                      <div className="quick-cash">
                        <div className="small muted">Recebido em dinheiro</div>
                        <div className="row wrap">
                          {cashSuggestions(line.amountCents ?? 0).map((v) => (
                            <button key={v} type="button" className={`chip ${p.receivedCents === v ? 'active' : ''}`} onClick={() => setLine(i, { receivedCents: v })}>{formatBRL(v)}</button>
                          ))}
                        </div>
                        <MoneyInput value={p.receivedCents} onChange={(v) => setLine(i, { receivedCents: v })} placeholder="Outro valor" />
                      </div>
                    )}
                  </div>
                );
              })}
              {payments.length < 4 && (
                <Button size="small" variant="plain" icon={<Plus size={15} />} onClick={() => setPayments((x) => [...x.map((l, n) => (n === x.length - 1 ? { ...l, amountCents: lines[n]!.amountCents } : l)), { method: 'cash', amountCents: null, receivedCents: null }])}>
                  Dividir em outra forma
                </Button>
              )}
              {change > 0 && <div className="quick-change pop-in"><span>Troco</span><strong className="num">{formatBRL(change)}</strong></div>}
              {printSw && (
                <div className="quick-print">
                  <Switch checked={printSw.quickTicket} onChange={(v) => void setPrintSw({ quickTicket: v })} label={<span className="row"><Printer size={15} /> Imprimir o ticket do pedido</span>} />
                  <Switch checked={printSw.quickReceipt} onChange={(v) => void setPrintSw({ quickReceipt: v })} label={<span className="row"><Printer size={15} /> Imprimir o comprovante de pagamento</span>} description="Os dois ficam como você deixar para as próximas vendas." />
                </div>
              )}
              <Button variant="primary" size="large" block disabled={!ready} loading={busy} icon={<CheckCircle2 size={20} />} onClick={finish}>
                Finalizar {total > 0 && formatBRL(total)}
              </Button>
              <div className="tiny subtle" style={{ textAlign: 'center' }}>Ctrl + Enter finaliza · Esc fecha</div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
