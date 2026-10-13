import { PAYMENT_METHODS, splitEqually, type PaymentMethod } from '@rupbar/core';
import {
  ArrowLeft, ArrowRightLeft, Ban, CheckCircle2, CreditCard, Divide, Eye, MoreHorizontal, Pencil, Percent, Plus, Printer, RotateCcw, Tag, Trash2,
  Undo2, Wind, X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { OrderComposer } from '../components/OrderComposer';
import {
  DeleteComandaModal, DeleteItemModal, DeletePaymentModal, EditItemModal, EditPaymentModal, OwnerTag, ReopenComandaModal,
} from '../components/OwnerActions';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Input, Loading, Modal, MoneyInput, Select, Switch, Textarea, useToast } from '../components/ui';
import { api, requestId } from '../lib/api';
import { elapsed, fmtDateTime, fmtTime, formatBRL } from '../lib/format';
import { useLoad, useNow } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { PixQr } from '../components/PixQr';
import { useSession } from '../lib/session';
import { STATUS_BADGE, type ComandaSummary } from './Comandas';
import '../styles/comandas.css';

export interface ComandaItem {
  id: string;
  orderId: string | null;
  orderNumber: number | null;
  kind: 'product' | 'hookah';
  name: string;
  presentationName: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  notes: string | null;
  station: string;
  status: 'active' | 'canceled';
  cancelReason: string | null;
  createdAt: string;
  createdByName: string | null;
  ticketStatus: string | null;
}

export interface ComandaDetail extends ComandaSummary {
  customerPhoneMasked: string;
  customerCpfMasked: string;
  subtotal: number;
  discount: number;
  serviceFee: number;
  serviceFeeBp: number;
  discountReason: string | null;
  notes: string | null;
  items: ComandaItem[];
  payments: { id: string; method: PaymentMethod; amount_cents: number; change_cents: number; payer_label: string | null; status: string; created_at: string; created_by_name: string | null; reverse_reason: string | null }[];
  hookahSessions: { id: string; status: string; started_at: string; code: string; charge_cents: number | null }[];
}

const TICKET_LABEL: Record<string, string> = { received: 'Recebido', preparing: 'Em preparo', ready: 'Pronto', delivered: 'Entregue', canceled: 'Cancelado' };

export function ComandaDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const now = useNow();
  const { data: c, error, reload } = useLoad(() => api.get<ComandaDetail>(`/api/comandas/${id}`), [id]);
  useRealtime(['comanda.changed', 'order.status', 'ticket.updated'], (e) => {
    if (!e.data?.comandaId || e.data.comandaId === id) void reload();
  });
  const [modal, setModal] = useState<null | 'order' | 'pay' | 'transfer' | 'move' | 'discount' | 'fee' | 'split' | 'close' | 'cancel' | 'contact' | 'more' | 'edit' | 'reopen' | 'delete'>(null);
  const [cancelItem, setCancelItem] = useState<ComandaItem | null>(null);
  const [fix, setFix] = useState<null | { kind: 'editItem' | 'deleteItem'; item: ComandaItem } | { kind: 'editPay' | 'deletePay'; payment: ComandaDetail['payments'][number] }>(null);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!c) return <Loading />;
  const open = c.status === 'open';
  const master = can('admin.override');
  const orders = groupByOrder(c.items);

  const printBill = async () => {
    try {
      await api.post(`/api/comandas/${id}/print`);
      toast.success('Conta enviada para impressão');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="stack-l">
      <div className="row between wrap">
        <div className="row" style={{ gap: 14 }}>
          <Button variant="plain" icon={<ArrowLeft size={18} />} aria-label="Voltar" onClick={() => nav('/comandas')} />
          {c.kind !== 'quick' && <span className="comanda-no">{c.displayNumber ?? c.number}</span>}
          <div>
            <div className="row">
              <h1>{c.kind === 'quick' ? `Venda rápida ${c.number}` : `Comanda ${c.displayNumber ?? c.number}`}</h1>
              {STATUS_BADGE[c.status]}
              {(open ? can('comandas.edit') : master) && <Button size="small" variant="plain" icon={<Pencil size={15} />} aria-label="Editar nome, cartão e mesa" onClick={() => setModal('edit')} />}
            </div>
            <div className="muted">
              {c.customerName || 'Sem nome'}
              {c.table && <> · Mesa {c.table}</>}
              {' · '}aberta {fmtDateTime(c.openedAt)} ({elapsed(c.openedAt, now)}){c.responsibleName && <> · {c.responsibleName}</>}
            </div>
          </div>
        </div>
        {!open && master && (
          <div className="row wrap owner-zone">
            <OwnerTag />
            {c.status === 'closed' && <Button icon={<RotateCcw size={16} />} onClick={() => setModal('reopen')}>Reabrir</Button>}
            {c.status !== 'canceled' && <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setModal('delete')}>Excluir comanda</Button>}
          </div>
        )}
        {open && (
          <div className="row wrap">
            {can('orders.create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal('order')}>Lançar itens</Button>}
            {can('cash.payment') && c.remaining > 0 && <Button icon={<CreditCard size={16} />} onClick={() => setModal('pay')}>Receber</Button>}
            <Button icon={<MoreHorizontal size={16} />} onClick={() => setModal('more')}>Mais</Button>
          </div>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(300px, 1fr)', alignItems: 'start' }}>
        <div className="stack">
          {orders.length === 0 && <Card><p className="muted">Nenhum item lançado ainda.</p></Card>}
          {orders.map((o) => (
            <Card key={o.key} flush>
              <div className="row between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--separator)' }}>
                <span className="strong">{o.title}</span>
                <span className="small muted">{fmtTime(o.items[0]!.createdAt)} · {o.items[0]!.createdByName}</span>
              </div>
              <div className="list">
                {o.items.map((i) => (
                  <div key={i.id} className="list-item" style={{ opacity: i.status === 'canceled' ? 0.55 : 1 }}>
                    <span className="strong num" style={{ minWidth: 30 }}>{i.quantity}×</span>
                    <div className="grow">
                      <div style={{ textDecoration: i.status === 'canceled' ? 'line-through' : undefined }}>
                        {i.kind === 'hookah' && <Wind size={14} style={{ marginRight: 4, verticalAlign: -2 }} />}
                        {i.name} {i.presentationName !== 'Unidade' && <span className="muted">· {i.presentationName}</span>}
                      </div>
                      {i.notes && <div className="small warning-text">{i.notes}</div>}
                      {i.status === 'canceled' && <div className="small danger-text">Cancelado: {i.cancelReason}</div>}
                    </div>
                    {i.ticketStatus && i.status === 'active' && <Badge color={i.ticketStatus === 'ready' ? 'green' : i.ticketStatus === 'delivered' ? undefined : 'orange'}>{TICKET_LABEL[i.ticketStatus] ?? i.ticketStatus}</Badge>}
                    <span className="num" style={{ minWidth: 86, textAlign: 'right' }}>{formatBRL(i.totalCents)}</span>
                    {master && i.status === 'active' ? (
                      <>
                        <Button size="small" variant="plain" icon={<Pencil size={15} />} aria-label="Editar item" title="Editar (conta mestre)" onClick={() => setFix({ kind: 'editItem', item: i })} />
                        <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Excluir item" title="Excluir (conta mestre)" onClick={() => setFix({ kind: 'deleteItem', item: i })} />
                      </>
                    ) : open && i.status === 'active' && can('comandas.cancel_item') && (
                      <Button size="small" variant="plain" icon={<X size={15} />} aria-label="Cancelar item" onClick={() => setCancelItem(i)} />
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ))}
          {c.hookahSessions.some((h) => h.status === 'active') && (
            <div className="banner"><Wind size={18} /> Narguilé em uso nesta comanda. O aluguel e as trocas já estão lançados; registre a devolução em Narguilés antes de encerrar.</div>
          )}
        </div>

        <div className="stack" style={{ position: 'sticky', top: 76 }}>
          <Card>
            <div className="col" style={{ gap: 6 }}>
              <Line label="Subtotal" value={formatBRL(c.subtotal)} />
              {c.discount > 0 && <Line label={`Desconto${c.discountReason ? ` (${c.discountReason})` : ''}`} value={`− ${formatBRL(c.discount)}`} />}
              {c.serviceFee > 0 && <Line label={`Taxa de serviço (${c.serviceFeeBp / 100}%)`} value={formatBRL(c.serviceFee)} />}
              <div className="divider" />
              <Line label={<strong>Total</strong>} value={<strong style={{ fontSize: 22 }}>{formatBRL(c.total)}</strong>} />
              {c.paid > 0 && <Line label="Pago" value={formatBRL(c.paid)} />}
              {!open && c.paid > c.total && <Line label={<strong>Pago a mais</strong>} value={<strong className="warning-text">{formatBRL(c.paid - c.total)}</strong>} />}
              {open && <Line label={<strong>Restante</strong>} value={<strong className={c.remaining > 0 ? 'warning-text' : 'success-text'}>{formatBRL(c.remaining)}</strong>} />}
            </div>
            {open && (
              <div className="col" style={{ marginTop: 16 }}>
                {c.remaining > 0 && can('cash.payment') && <Button variant="primary" size="large" block icon={<CreditCard size={18} />} onClick={() => setModal('pay')}>Receber pagamento</Button>}
                {c.remaining <= 0 && can('comandas.close') && c.items.some((i) => i.status === 'active') && (
                  <Button variant="success" size="large" block icon={<CheckCircle2 size={18} />} onClick={() => setModal('close')}>Encerrar comanda</Button>
                )}
                <div className="row">
                  <Button block icon={<Divide size={16} />} onClick={() => setModal('split')}>Dividir</Button>
                  <Button block icon={<Printer size={16} />} onClick={printBill}>Conta</Button>
                </div>
              </div>
            )}
          </Card>
          {c.payments.length > 0 && (
            <Card title="Pagamentos" flush>
              <div className="list">
                {c.payments.map((p) => (
                  <div key={p.id} className="list-item" style={{ opacity: p.status === 'reversed' ? 0.55 : 1 }}>
                    <div className="grow">
                      <div style={{ textDecoration: p.status === 'reversed' ? 'line-through' : undefined }}>
                        {PAYMENT_METHODS[p.method]}{p.payer_label && <span className="muted"> · {p.payer_label}</span>}
                      </div>
                      <div className="tiny muted">{fmtTime(p.created_at)} · {p.created_by_name}{p.change_cents > 0 && ` · troco ${formatBRL(p.change_cents)}`}</div>
                      {p.status === 'reversed' && <div className="tiny danger-text">Estornado: {p.reverse_reason}</div>}
                    </div>
                    <span className="num">{formatBRL(p.amount_cents)}</span>
                    {master && p.status === 'active' ? (
                      <>
                        <Button size="small" variant="plain" icon={<Pencil size={15} />} aria-label="Corrigir pagamento" title="Corrigir (conta mestre)" onClick={() => setFix({ kind: 'editPay', payment: p })} />
                        <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Excluir pagamento" title="Excluir (conta mestre)" onClick={() => setFix({ kind: 'deletePay', payment: p })} />
                      </>
                    ) : open && p.status === 'active' && can('cash.payment_reverse') && <ReverseButton paymentId={p.id} onDone={reload} />}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {modal === 'order' && (
        <Modal title={`Lançar itens — ${c.label}`} wide onClose={() => setModal(null)}>
          <OrderComposer comandaId={c.id} onSent={() => { setModal(null); void reload(); }} />
        </Modal>
      )}
      {modal === 'pay' && <PaymentModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'split' && <SplitModal comanda={c} onClose={() => setModal(null)} onPay={() => setModal('pay')} />}
      {modal === 'more' && (
        <Modal title="Ações da comanda" onClose={() => setModal(null)}>
          <div className="col">
            {can('comandas.transfer') && <ActionRow icon={<ArrowRightLeft size={18} />} label="Transferir mesa" onClick={() => setModal('transfer')} />}
            {can('comandas.transfer') && <ActionRow icon={<ArrowRightLeft size={18} />} label="Mover itens para outra comanda" onClick={() => setModal('move')} />}
            {can('comandas.discount') && <ActionRow icon={<Tag size={18} />} label="Desconto" onClick={() => setModal('discount')} />}
            {can('comandas.discount') && <ActionRow icon={<Percent size={18} />} label="Taxa de serviço" onClick={() => setModal('fee')} />}
            {can('comandas.open') && (c.customerPhoneMasked || c.customerCpfMasked) && <ActionRow icon={<Eye size={18} />} label="Ver contato do cliente" onClick={() => setModal('contact')} />}
            {can('comandas.cancel') && <ActionRow icon={<Ban size={18} />} label="Cancelar comanda" danger onClick={() => setModal('cancel')} />}
            {master && c.paid > 0 && <ActionRow icon={<Trash2 size={18} />} label="Excluir comanda com pagamentos (conta mestre)" danger onClick={() => setModal('delete')} />}
          </div>
        </Modal>
      )}
      {modal === 'transfer' && <TransferModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'move' && <MoveItemsModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'discount' && <DiscountModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'fee' && <ServiceFeeModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'contact' && <ContactModal comandaId={c.id} onClose={() => setModal(null)} />}
      {modal === 'close' && (
        <Confirm title={`Encerrar ${c.label}?`} message={`Total ${formatBRL(c.total)} pago integralmente.`} confirmLabel="Encerrar" onClose={() => setModal(null)}
          onConfirm={async () => { await api.post(`/api/comandas/${c.id}/close`, { expectedVersion: c.version }); toast.success('Comanda encerrada'); await reload(); }} />
      )}
      {modal === 'cancel' && <CancelComandaModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {cancelItem && <CancelItemModal item={cancelItem} onClose={() => setCancelItem(null)} onDone={reload} />}
      {modal === 'edit' && <EditComandaModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'reopen' && <ReopenComandaModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'delete' && <DeleteComandaModal comanda={c} onClose={() => setModal(null)} onDone={reload} />}
      {fix?.kind === 'editItem' && <EditItemModal item={fix.item} onClose={() => setFix(null)} onDone={reload} />}
      {fix?.kind === 'deleteItem' && <DeleteItemModal item={fix.item} onClose={() => setFix(null)} onDone={reload} />}
      {fix?.kind === 'editPay' && <EditPaymentModal payment={fix.payment} onClose={() => setFix(null)} onDone={reload} />}
      {fix?.kind === 'deletePay' && <DeletePaymentModal payment={fix.payment} onClose={() => setFix(null)} onDone={reload} />}
    </div>
  );
}

function groupByOrder(items: ComandaItem[]) {
  const groups: { key: string; title: string; items: ComandaItem[] }[] = [];
  for (const i of items) {
    const key = i.orderId ?? `${i.kind}-${i.id}`;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, title: i.orderNumber ? `Pedido ${i.orderNumber}` : i.kind === 'hookah' ? 'Narguilé' : 'Lançamento', items: [] };
      groups.push(g);
    }
    g.items.push(i);
  }
  return groups;
}

function Line({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="row between">
      <span className="muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

function ActionRow({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" className="list-item clickable" style={{ border: 0, background: 'transparent', textAlign: 'left', color: danger ? 'var(--red)' : undefined, borderRadius: 10 }} onClick={onClick}>
      {icon}
      <span className="strong">{label}</span>
    </button>
  );
}

function ReverseButton({ paymentId, onDone }: { paymentId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <>
      <Button size="small" variant="plain" icon={<Undo2 size={15} />} aria-label="Estornar" onClick={() => setOpen(true)} />
      {open && (
        <Confirm title="Estornar pagamento" danger confirmLabel="Estornar" onClose={() => setOpen(false)}
          onConfirm={async () => { await api.post(`/api/payments/${paymentId}/reverse`, { reason }); onDone(); }}>
          <Field label="Motivo *"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </Confirm>
      )}
    </>
  );
}

export function PaymentModal({ comanda, onClose, onDone, presetAmount, presetLabel }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void; presetAmount?: number; presetLabel?: string }) {
  const toast = useToast();
  const [method, setMethod] = useState<PaymentMethod>('pix');
  const [amount, setAmount] = useState<number | null>(presetAmount ?? comanda.remaining);
  const [received, setReceived] = useState<number | null>(null);
  const [label, setLabel] = useState(presetLabel ?? '');
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);
  const change = method === 'cash' && received !== null && amount !== null ? Math.max(0, received - amount) : 0;

  const submit = async () => {
    if (!amount || amount <= 0) return toast.error('Informe o valor.');
    if (amount > comanda.remaining) return toast.error(`O saldo é ${formatBRL(comanda.remaining)}.`);
    setBusy(true);
    try {
      const r = await api.post<{ changeCents?: number }>('/api/payments', {
        comandaId: comanda.id, method, amountCents: amount, receivedCents: method === 'cash' && received ? received : undefined,
        payerLabel: label || null, clientRequestId: rid,
      });
      toast.success(r.changeCents ? `Pagamento registrado. Troco: ${formatBRL(r.changeCents)}` : 'Pagamento registrado');
      onDone();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Receber — ${comanda.label}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit}>Confirmar {amount ? formatBRL(amount) : ''}</Button></>}>
      <div className="stack">
        <div className="banner"><span className="grow">Saldo da comanda</span><strong className="num">{formatBRL(comanda.remaining)}</strong></div>
        <div className="grid-3" style={{ gap: 8 }}>
          {(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((m) => (
            <button key={m} type="button" className={`chip ${method === m ? 'active' : ''}`} style={{ justifyContent: 'center', height: 44 }} onClick={() => setMethod(m)}>{PAYMENT_METHODS[m]}</button>
          ))}
        </div>
        <div className="grid-2">
          <Field label="Valor deste pagamento"><MoneyInput large value={amount} onChange={setAmount} /></Field>
          {method === 'cash' && <Field label="Valor recebido (para troco)"><MoneyInput large value={received} onChange={setReceived} /></Field>}
        </div>
        {method === 'cash' && change > 0 && <div className="banner success"><span className="grow">Troco</span><strong className="num" style={{ fontSize: 20 }}>{formatBRL(change)}</strong></div>}
        {method === 'pix' && <PixQr amountCents={amount ?? 0} comandaId={comanda.id} />}
        <Field label="Identificação (opcional)" hint="Útil em contas divididas: ex. “Pessoa 2”."><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function SplitModal({ comanda, onClose }: { comanda: ComandaDetail; onClose: () => void; onPay: () => void }) {
  const [parts, setParts] = useState(2);
  const [paying, setPaying] = useState<{ amount: number; label: string } | null>(null);
  const shares = splitEqually(Math.max(0, comanda.remaining), parts);
  if (paying) return <PaymentModal comanda={comanda} presetAmount={paying.amount} presetLabel={paying.label} onClose={onClose} onDone={() => undefined} />;
  return (
    <Modal title="Dividir conta" onClose={onClose}>
      <div className="stack">
        <Field label="Número de pessoas">
          <div className="stepper" style={{ alignSelf: 'flex-start' }}>
            <button type="button" onClick={() => setParts(Math.max(1, parts - 1))}>−</button>
            <span>{parts}</span>
            <button type="button" onClick={() => setParts(Math.min(50, parts + 1))}>+</button>
          </div>
        </Field>
        <p className="small muted">Divisão do saldo restante de {formatBRL(comanda.remaining)}, sem perder centavos. Cada parte é registrada como um pagamento.</p>
        <div className="list card flush">
          {shares.map((s, i) => (
            <div key={i} className="list-item">
              <span className="grow">Pessoa {i + 1}</span>
              <span className="num strong">{formatBRL(s)}</span>
              <Button size="small" variant="primary" onClick={() => setPaying({ amount: s, label: `Pessoa ${i + 1} de ${parts}` })}>Receber</Button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function TransferModal({ comanda, onClose, onDone }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void }) {
  const [table, setTable] = useState(comanda.table ?? '');
  return (
    <Confirm title="Transferir mesa" confirmLabel="Transferir" onClose={onClose}
      onConfirm={async () => { await api.post(`/api/comandas/${comanda.id}/transfer`, { table, expectedVersion: comanda.version }); onDone(); }}>
      <Field label="Nova mesa"><Input autoFocus value={table} onChange={(e) => setTable(e.target.value)} /></Field>
    </Confirm>
  );
}

function MoveItemsModal({ comanda, onClose, onDone }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void }) {
  const others = useLoad(() => api.get<ComandaSummary[]>('/api/comandas?status=open'));
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const items = comanda.items.filter((i) => i.status === 'active');
  return (
    <Confirm title="Mover itens" confirmLabel="Mover" onClose={onClose}
      onConfirm={async () => { await api.post(`/api/comandas/${comanda.id}/move-items`, { itemIds: selected, targetComandaId: target, expectedVersion: comanda.version }); onDone(); }}>
      <Field label="Comanda de destino">
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Selecione…</option>
          {others.data?.filter((o) => o.id !== comanda.id).map((o) => <option key={o.id} value={o.id}>{o.label} — {o.customerName || 'sem nome'}{o.table ? ` (mesa ${o.table})` : ''}</option>)}
        </Select>
      </Field>
      <div className="col">
        {items.map((i) => (
          <label key={i.id} className="check">
            <input type="checkbox" checked={selected.includes(i.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, i.id] : selected.filter((x) => x !== i.id))} />
            <span className="grow">{i.quantity}× {i.name} {i.presentationName !== 'Unidade' && `· ${i.presentationName}`}</span>
            <span className="num muted">{formatBRL(i.totalCents)}</span>
          </label>
        ))}
      </div>
    </Confirm>
  );
}

function DiscountModal({ comanda, onClose, onDone }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState<number | null>(comanda.discount || null);
  const [reason, setReason] = useState(comanda.discountReason ?? '');
  return (
    <Confirm title="Desconto" confirmLabel="Aplicar" onClose={onClose}
      onConfirm={async () => { await api.post(`/api/comandas/${comanda.id}/discount`, { discountCents: value ?? 0, reason, expectedVersion: comanda.version }); onDone(); }}>
      <Field label="Valor do desconto"><MoneyInput autoFocus value={value} onChange={setValue} /></Field>
      <Field label="Motivo *"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cortesia da casa" /></Field>
    </Confirm>
  );
}

function ServiceFeeModal({ comanda, onClose, onDone }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void }) {
  const [bp, setBp] = useState(comanda.serviceFeeBp);
  return (
    <Confirm title="Taxa de serviço" confirmLabel="Salvar" onClose={onClose}
      onConfirm={async () => { await api.post(`/api/comandas/${comanda.id}/service-fee`, { serviceFeeBp: bp, expectedVersion: comanda.version }); onDone(); }}>
      <Select value={bp} onChange={(e) => setBp(Number(e.target.value))}>
        {[0, 500, 1000, 1200, 1300, 1500].map((v) => <option key={v} value={v}>{v === 0 ? 'Sem taxa' : `${v / 100}%`}</option>)}
      </Select>
    </Confirm>
  );
}

function ContactModal({ comandaId, onClose }: { comandaId: string; onClose: () => void }) {
  const { data } = useLoad(() => api.get<{ phone: string | null; cpf: string | null }>(`/api/comandas/${comandaId}/contact`));
  return (
    <Modal title="Contato do cliente" onClose={onClose}>
      <div className="stack">
        <p className="small muted">Acesso registrado na auditoria (LGPD).</p>
        <div><div className="label">Telefone</div><div className="strong">{data?.phone ?? '—'}</div></div>
        <div><div className="label">CPF</div><div className="strong">{data?.cpf ?? '—'}</div></div>
      </div>
    </Modal>
  );
}

function CancelItemModal({ item, onClose, onDone }: { item: ComandaItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [returnToStock, setReturn] = useState(item.ticketStatus === 'received' || !item.ticketStatus);
  return (
    <Confirm title="Cancelar item" danger confirmLabel="Cancelar item" onClose={onClose}
      message={`${item.quantity}× ${item.name} — ${formatBRL(item.totalCents)}`}
      onConfirm={async () => { await api.post(`/api/comanda-items/${item.id}/cancel`, { reason, returnToStock }); onDone(); }}>
      <Field label="Justificativa *"><Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: lançado errado, cliente desistiu" /></Field>
      {item.kind === 'product' && <Switch checked={returnToStock} onChange={setReturn} label="Devolver ao estoque" description="Desative se o item já foi preparado/servido (desperdício)." />}
    </Confirm>
  );
}

function CancelComandaModal({ comanda, onClose, onDone }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [returnToStock, setReturn] = useState(true);
  return (
    <Confirm title={`Cancelar ${comanda.label}`} danger confirmLabel="Cancelar comanda" onClose={onClose}
      message="Todos os itens serão cancelados. Esta ação fica registrada na auditoria."
      onConfirm={async () => { await api.post(`/api/comandas/${comanda.id}/cancel`, { reason, returnToStock, expectedVersion: comanda.version }); onDone(); }}>
      <Field label="Justificativa *"><Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Switch checked={returnToStock} onChange={setReturn} label="Devolver itens ao estoque" />
    </Confirm>
  );
}

function EditComandaModal({ comanda, onClose, onDone }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ customerName: comanda.customerName, cardNumber: comanda.cardNumber === null ? '' : String(comanda.cardNumber), table: comanda.table ?? '' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/comandas/${comanda.id}`, {
        customerName: form.customerName, cardNumber: form.cardNumber ? Number(form.cardNumber) : null, table: form.table || null,
        notes: comanda.notes ?? null, expectedVersion: comanda.version,
      });
      toast.success('Comanda atualizada');
      onDone();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Editar comanda" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!form.customerName.trim() && !form.cardNumber} onClick={submit}>Salvar</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="open-comanda-head">
          <Field label="Nº do cartão"><Input large inputMode="numeric" className="card-input" value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: e.target.value.replace(/\D/g, '').slice(0, 5) })} /></Field>
          <Field label="Nome do cliente"><Input large autoFocus value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></Field>
        </div>
        <Field label="Mesa / identificação"><Input value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
