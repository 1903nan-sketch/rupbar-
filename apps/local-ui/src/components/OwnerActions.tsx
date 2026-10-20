import { presentationSuffix, type PaymentMethod } from '@rupbar/core';
import { ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { formatBRL, PAYMENT_METHODS } from '../lib/format';
import { Button, Field, Input, Modal, MoneyInput, Select, Switch, Textarea, useToast } from './ui';

/**
 * Correções da conta mestre (somente o proprietário). Toda correção pede um
 * motivo e fica no histórico; nada é apagado do banco.
 */
export function OwnerTag() {
  return <span className="owner-tag"><ShieldCheck size={13} /> Conta mestre</span>;
}

export function ReasonModal({ title, description, confirmLabel = 'Salvar correção', danger, children, onConfirm, onClose, valid = true }: {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  children?: ReactNode;
  valid?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (reason.trim().length < 3) return toast.error('Informe o motivo da correção.');
    setBusy(true);
    try {
      await onConfirm(reason.trim());
      toast.success('Correção registrada');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Voltar</Button><Button variant={danger ? 'danger' : 'primary'} className={danger ? 'solid' : ''} loading={busy} disabled={!valid} onClick={submit}>{confirmLabel}</Button></>}
    >
      <div className="stack">
        <OwnerTag />
        {description && <div className="muted">{description}</div>}
        {children}
        <Field label="Motivo *" hint="Fica registrado no histórico de correções.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: lançado errado, cliente pagou no Pix…" autoFocus={!children} />
        </Field>
      </div>
    </Modal>
  );
}

export function EditItemModal({ item, onClose, onDone }: {
  item: { id: string; name: string; presentationName: string; quantity: number; unitPriceCents: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const [qty, setQty] = useState(String(item.quantity));
  const [price, setPrice] = useState<number | null>(item.unitPriceCents);
  const q = Number(qty);
  const valid = Number.isInteger(q) && q >= 1 && q <= 999 && price !== null && price >= 0;
  return (
    <ReasonModal
      title="Editar item"
      description={<>{item.name}{presentationSuffix(item.name, item.presentationName) && ` · ${item.presentationName}`}. Mudar a quantidade ajusta o estoque automaticamente.</>}
      valid={valid}
      onClose={onClose}
      onConfirm={async (reason) => {
        await api.put(`/api/admin/comanda-items/${item.id}`, { quantity: q, unitPriceCents: price, reason });
        onDone();
      }}
    >
      <div className="grid-2">
        <Field label="Quantidade"><Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 3))} autoFocus /></Field>
        <Field label="Preço unitário"><MoneyInput value={price} onChange={setPrice} /></Field>
      </div>
      {valid && <div className="small muted">Novo total do item: <strong className="num">{formatBRL(q * (price ?? 0))}</strong></div>}
    </ReasonModal>
  );
}

export function DeleteItemModal({ item, onClose, onDone }: { item: { id: string; name: string; quantity: number; kind: string }; onClose: () => void; onDone: () => void }) {
  const [returnToStock, setReturnToStock] = useState(true);
  return (
    <ReasonModal
      title="Excluir item"
      danger
      confirmLabel="Excluir item"
      description={<>{item.quantity}× {item.name}. Vale mesmo para comandas já encerradas.</>}
      onClose={onClose}
      onConfirm={async (reason) => {
        await api.post(`/api/admin/comanda-items/${item.id}/delete`, { reason, returnToStock });
        onDone();
      }}
    >
      {item.kind === 'product' && <Switch checked={returnToStock} onChange={setReturnToStock} label="Devolver ao estoque" description="Desligue se o produto foi consumido ou perdido." />}
    </ReasonModal>
  );
}

export function EditPaymentModal({ payment, onClose, onDone }: { payment: { id: string; method: PaymentMethod; amount_cents: number }; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<PaymentMethod>(payment.method);
  const [amount, setAmount] = useState<number | null>(payment.amount_cents);
  return (
    <ReasonModal
      title="Corrigir pagamento"
      description="O pagamento original é estornado e o corrigido é lançado no mesmo caixa. Se o caixa já foi fechado, o resumo é recalculado."
      valid={!!amount && amount > 0}
      onClose={onClose}
      onConfirm={async (reason) => {
        await api.put(`/api/admin/payments/${payment.id}`, { method, amountCents: amount, reason });
        onDone();
      }}
    >
      <div className="grid-2">
        <Field label="Forma de pagamento">
          <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Valor"><MoneyInput value={amount} onChange={setAmount} /></Field>
      </div>
    </ReasonModal>
  );
}

export function DeletePaymentModal({ payment, onClose, onDone }: { payment: { id: string; method: PaymentMethod; amount_cents: number }; onClose: () => void; onDone: () => void }) {
  return (
    <ReasonModal
      title="Excluir pagamento"
      danger
      confirmLabel="Excluir pagamento"
      description={<>{PAYMENT_METHODS[payment.method]} de {formatBRL(payment.amount_cents)}. Se a comanda estava encerrada e ficar com saldo, ela é reaberta para cobrar.</>}
      onClose={onClose}
      onConfirm={async (reason) => {
        await api.post(`/api/admin/payments/${payment.id}/delete`, { reason });
        onDone();
      }}
    />
  );
}

export function DeleteComandaModal({ comanda, onClose, onDone }: { comanda: { id: string; label: string; paid: number }; onClose: () => void; onDone: () => void }) {
  const [returnToStock, setReturnToStock] = useState(true);
  return (
    <ReasonModal
      title={`Excluir ${comanda.label}`}
      danger
      confirmLabel="Excluir comanda"
      description={<>Estorna {comanda.paid > 0 ? `os pagamentos (${formatBRL(comanda.paid)})` : 'os pagamentos'}, cancela itens e pedidos e recalcula o caixa. A comanda fica no histórico como excluída.</>}
      onClose={onClose}
      onConfirm={async (reason) => {
        await api.post(`/api/admin/comandas/${comanda.id}/delete`, { reason, returnToStock });
        onDone();
      }}
    >
      <Switch checked={returnToStock} onChange={setReturnToStock} label="Devolver os produtos ao estoque" />
    </ReasonModal>
  );
}

export function ReopenComandaModal({ comanda, onClose, onDone }: { comanda: { id: string; label: string }; onClose: () => void; onDone: () => void }) {
  return (
    <ReasonModal
      title={`Reabrir ${comanda.label}`}
      confirmLabel="Reabrir"
      description="A comanda volta para as abertas para lançar ou corrigir itens e pagamentos."
      onClose={onClose}
      onConfirm={async (reason) => {
        await api.post(`/api/admin/comandas/${comanda.id}/reopen`, { reason });
        onDone();
      }}
    />
  );
}
