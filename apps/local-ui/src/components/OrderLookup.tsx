import { PAYMENT_METHODS, parsePickupCode, presentationSuffix, type PaymentMethod } from '@rupbar/core';
import { CheckCircle2, CircleAlert, CircleX, HandPlatter, Printer, ScanBarcode, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime, formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useBarcodeScanner } from '../lib/scanner';
import { useSession } from '../lib/session';
import '../styles/lookup.css';
import { Badge, Button, Empty, ErrorBox, Input, Loading, Modal, useToast } from './ui';

export interface OrderCheck {
  id: string;
  number: number;
  code: string;
  quick: boolean;
  comandaId: string;
  comandaDisplayNumber: number | null;
  table: string | null;
  customerDisplayName: string;
  createdAt: string;
  comandaStatus: string;
  payment: 'paid' | 'open' | 'canceled';
  orderTotal: number;
  comandaTotal: number;
  paidCents: number;
  remaining: number;
  payments: { method: string; amount_cents: number; created_at: string }[];
  pickedUpAt: string | null;
  pickedUpBy: string | null;
  ticketPrints: number;
  items: { id: string; product_name: string; presentation_name: string; options_label?: string | null; quantity: number; unit_price_cents: number; status: string }[];
}

/** Evita uma busca a cada tecla. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Conferir pedido: o cliente perdeu o ticket ou o bar quer confirmar antes de
 * entregar. Bipe o código de barras do ticket ou busque pelo número do
 * pedido, do cartão ou pelo nome. Mostra se está pago e se já foi entregue.
 */
export function OrderLookup({ initial = '', onClose }: { initial?: string; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const term = useDebounced(q.trim(), parsePickupCode(q) ? 0 : 300);
  const { data, error, reload } = useLoad(() => (term ? api.get<OrderCheck[]>(`/api/orders/lookup?q=${encodeURIComponent(term)}`) : Promise.resolve(null)), [term]);
  // Com a conferência aberta, bipar outro ticket troca a busca.
  useBarcodeScanner((code) => {
    if (!parsePickupCode(code)) return false;
    setQ(code);
    return true;
  });

  return (
    <Modal title="Conferir pedido" wide onClose={onClose}>
      <div className="stack">
        <div className="input-group">
          <Search size={17} className="prefix" />
          <Input large autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bipe o ticket ou digite o número do pedido, do cartão ou o nome" aria-label="Buscar pedido" />
        </div>
        {!term ? (
          <Empty icon={<ScanBarcode size={40} />} title="Bipe o código de barras do ticket">
            Ou digite o número do pedido, o número do cartão ou o nome do cliente (pedidos dos últimos 2 dias).
          </Empty>
        ) : error ? <ErrorBox error={error} onRetry={reload} /> : !data ? <Loading /> : data.length === 0 ? (
          <Empty icon={<CircleAlert size={40} />} title="Nenhum pedido encontrado">Confira o número ou tente pelo nome do cliente.</Empty>
        ) : (
          <div className="stack">{data.map((o) => <OrderCheckCard key={o.id} order={o} highlight={data.length === 1} onChanged={reload} />)}</div>
        )}
      </div>
    </Modal>
  );
}

function OrderCheckCard({ order: o, highlight, onChanged }: { order: OrderCheck; highlight: boolean; onChanged: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const [busy, setBusy] = useState<'deliver' | 'print' | null>(null);
  const items = o.items.filter((i) => i.status === 'active');
  const canDeliver = !o.pickedUpAt && o.payment !== 'canceled' && (can('orders.create') || can('kitchen.update'));

  const run = async (kind: 'deliver' | 'print') => {
    setBusy(kind);
    try {
      if (kind === 'deliver') {
        await api.post(`/api/orders/${o.id}/picked-up`);
        toast.success(`Pedido ${o.number} entregue`);
      } else {
        await api.post(`/api/orders/${o.id}/ticket`);
        toast.success('2ª via enviada para a impressora do caixa');
      }
      onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const verdict = o.payment === 'canceled'
    ? { cls: 'bad', icon: <CircleX size={30} />, title: 'Pedido cancelado', text: 'Não entregar.' }
    : o.pickedUpAt
      ? { cls: 'warn', icon: <CircleAlert size={30} />, title: `Já entregue às ${fmtTime(o.pickedUpAt)}`, text: o.pickedUpBy ? `por ${o.pickedUpBy}` : 'Confira antes de entregar de novo.' }
      : o.payment === 'paid'
        ? { cls: 'ok', icon: <CheckCircle2 size={30} />, title: 'Pago · pode entregar', text: o.quick ? 'Venda no caixa paga na hora.' : 'Comanda já paga.' }
        : { cls: 'info', icon: <CheckCircle2 size={30} />, title: `Lançado na comanda ${o.comandaDisplayNumber ?? ''}`, text: `Pode entregar: a comanda é paga na saída${o.remaining > 0 ? ` (falta ${formatBRL(o.remaining)})` : ''}.` };

  return (
    <div className={`card lookup-card ${highlight ? 'pop-in' : ''}`}>
      <div className={`lookup-verdict ${verdict.cls}`}>
        {verdict.icon}
        <div>
          <strong>{verdict.title}</strong>
          <div className="small">{verdict.text}</div>
        </div>
      </div>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div>
          <div className="lookup-number">Pedido {o.number}</div>
          <div className="strong">{o.customerDisplayName || 'Sem nome'}</div>
          <div className="small muted">
            {o.quick ? 'Venda rápida' : `Comanda ${o.comandaDisplayNumber}`}{o.table && ` · Mesa ${o.table}`} · {fmtDateTime(o.createdAt)}
          </div>
        </div>
        <div className="right">
          <div className="num strong" style={{ fontSize: 22 }}>{formatBRL(o.orderTotal)}</div>
          <div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {o.payments.map((p, i) => <Badge key={i} color="green">{PAYMENT_METHODS[p.method as PaymentMethod] ?? p.method} {formatBRL(p.amount_cents)}</Badge>)}
          </div>
        </div>
      </div>
      <ul className="lookup-items">
        {items.map((i) => (
          <li key={i.id}><strong>{i.quantity}×</strong> {i.product_name}{presentationSuffix(i.product_name, i.presentation_name) && ` (${i.presentation_name})`}{i.options_label && <span className="accent-text strong"> — {i.options_label}</span>}</li>
        ))}
      </ul>
      <div className="row wrap between" style={{ gap: 8 }}>
        <span className="tiny muted">Código {o.code} · ticket impresso {o.ticketPrints}×</span>
        <div className="row" style={{ gap: 8 }}>
          {can('cash.payment') && o.payment !== 'canceled' && (
            <Button icon={<Printer size={16} />} loading={busy === 'print'} onClick={() => void run('print')}>Imprimir 2ª via</Button>
          )}
          {canDeliver && (
            <Button variant="primary" icon={<HandPlatter size={16} />} loading={busy === 'deliver'} onClick={() => void run('deliver')}>Marcar como entregue</Button>
          )}
        </div>
      </div>
    </div>
  );
}
