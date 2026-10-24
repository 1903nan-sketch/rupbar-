import { billTotals } from '@rupbar/core';
import { BadgePercent, Check, Clock, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, isOfflineError, requestId } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { playAlert } from '../lib/sound';
import type { ComandaDetail } from '../pages/ComandaDetail';
import { Button, Field, Input, Modal, MoneyInput, useToast } from './ui';

export interface DiscountRequestView {
  id: string;
  comandaId: string;
  requestedBy: string;
  requestedByName: string;
  discountCents: number;
  reason: string;
  totalCents: number;
  totalAfterCents: number;
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
}

const REASONS = ['Cliente fiel', 'Demora no pedido', 'Produto com problema', 'Levou em quantidade'];

/**
 * Funcionário pede desconto: vai para o painel online do proprietário, que
 * aceita ou recusa. Enquanto isso dá para continuar usando o sistema.
 */
export function RequestDiscountModal({ comanda, onClose, onDone }: { comanda: ComandaDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(requestId);
  const lines = [{ quantity: 1, unitPrice: comanda.subtotal }];
  const opts = { serviceFeeBp: comanda.serviceFeeBp };
  const after = value ? billTotals(lines, { ...opts, discount: value }).total : null;
  const tooBig = !!value && value > comanda.subtotal;

  const submit = async () => {
    if (!value || tooBig || reason.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/comandas/${comanda.id}/discount-requests`, { clientRequestId: key, discountCents: value, reason: reason.trim() });
      toast.success('Pedido enviado ao proprietário. Pode continuar: quando ele responder, aparece um aviso.');
      onDone();
      onClose();
    } catch (e) {
      toast.error(isOfflineError(e) ? 'Sem conexão com o PC. Toque em "Pedir" de novo quando voltar — não duplica.' : e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Pedir desconto — ${comanda.label}`} onClose={onClose}
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="primary" icon={<BadgePercent size={16} />} loading={busy} disabled={!value || tooBig || reason.trim().length < 3} onClick={() => void submit()}>
          Pedir ao proprietário
        </Button>
      </>}>
      <div className="stack">
        <p className="small muted">Só o proprietário dá desconto. Ele recebe o pedido no painel online e aceita ou recusa.</p>
        <Field label="Valor do desconto" error={tooBig ? `Maior que os itens (${formatBRL(comanda.subtotal)}).` : null}>
          <MoneyInput autoFocus value={value} onChange={setValue} />
        </Field>
        <div className="row wrap" style={{ gap: 6 }}>
          {[5, 10, 15, 20].map((p) => (
            <Button key={p} size="small" onClick={() => setValue(Math.round((comanda.subtotal * p) / 100))}>{p}%</Button>
          ))}
        </div>
        <Field label="Motivo *">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cliente fiel" maxLength={200} />
        </Field>
        <div className="row wrap" style={{ gap: 6 }}>
          {REASONS.map((r) => <Button key={r} size="small" variant="plain" onClick={() => setReason(r)}>{r}</Button>)}
        </div>
        <div className="discount-preview-box">
          <div><span className="tiny muted">Valor da comanda</span><strong className="num">{formatBRL(comanda.total)}</strong></div>
          <div><span className="tiny muted">Desconto</span><strong className="num warning-text">{value ? `− ${formatBRL(value)}` : '—'}</strong></div>
          <div><span className="tiny muted">Vai ficar</span><strong className="num">{after !== null && !tooBig ? formatBRL(after) : '—'}</strong></div>
        </div>
      </div>
    </Modal>
  );
}

/** Pedido aguardando o proprietário, na comanda. O proprietário responde aqui mesmo. */
export function PendingDiscount({ request, onChanged }: { request: DiscountRequestView; onChanged: () => void }) {
  const toast = useToast();
  const { user, can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: 'cancel' | 'approve' | 'reject') => {
    setBusy(action);
    try {
      const r = await api.post<{ message?: string }>(`/api/discount-requests/${request.id}/${action}`, {});
      if (action === 'cancel') toast.success('Pedido de desconto cancelado');
      else toast.success(r.message ?? 'Feito');
      onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const owner = can('comandas.discount');
  return (
    <div className="banner warning discount-pending" role="status">
      <Clock size={18} />
      <div className="grow">
        <strong>Desconto de {formatBRL(request.discountCents)} pedido ao proprietário</strong>
        <div className="small">
          {request.requestedBy === user?.id ? 'Você pediu' : `${request.requestedByName} pediu`} · {request.reason} · fica {formatBRL(request.totalAfterCents)}
        </div>
        <div className="small muted">{owner ? 'Responda aqui ou no painel online.' : 'Aguardando a resposta. Pode continuar usando o sistema.'}</div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {owner ? (
          <>
            <Button size="small" icon={<X size={14} />} loading={busy === 'reject'} onClick={() => void run('reject')}>Recusar</Button>
            <Button size="small" variant="primary" icon={<Check size={14} />} loading={busy === 'approve'} onClick={() => void run('approve')}>Aceitar</Button>
          </>
        ) : request.requestedBy === user?.id && (
          <Button size="small" variant="plain" loading={busy === 'cancel'} onClick={() => void run('cancel')}>Cancelar pedido</Button>
        )}
      </div>
    </div>
  );
}

interface Notice extends DiscountRequestView {
  comandaLabel: string;
}

/**
 * Resposta do proprietário para quem pediu o desconto, em qualquer tela:
 * "O proprietário aplicou o desconto…". Fica até tocar em OK.
 */
export function DiscountNotices({ mobile }: { mobile?: boolean }) {
  const { user } = useSession();
  const nav = useNavigate();
  const [notices, setNotices] = useState<Notice[]>([]);
  const userId = user?.id;
  const load = useCallback(async (sound = false) => {
    if (!userId) return;
    try {
      const list = await api.get<Notice[]>('/api/discount-requests/notices');
      setNotices((prev) => {
        if (sound && list.some((n) => !prev.some((p) => p.id === n.id))) playAlert('call', { times: 1, volume: 0.7 });
        return list;
      });
    } catch {
      // Sem conexão: tenta de novo no próximo aviso.
    }
  }, [userId]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(t);
  }, [load]);
  useRealtime(['discount.decided'], (e) => {
    if (e.type === 'reconnected' || e.data?.requestedBy === userId) void load(true);
  });
  if (!notices.length) return null;
  const seen = (id: string) => {
    setNotices((l) => l.filter((n) => n.id !== id));
    void api.post(`/api/discount-requests/${id}/seen`, {}).catch(() => undefined);
  };
  return (
    <div className={`discount-notices${mobile ? ' mobile' : ''}`} role="alert" aria-live="assertive">
      {notices.map((n) => {
        const ok = n.status === 'approved';
        return (
          <div key={n.id} className={`discount-notice pop-in ${ok ? 'ok' : 'no'}`}>
            <span className="discount-notice-icon">{ok ? <Check size={20} /> : <X size={20} />}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <strong>{ok ? 'O proprietário aplicou o desconto' : 'O proprietário recusou o desconto'}</strong>
              <div className="small">
                {formatBRL(n.discountCents)} na {n.comandaLabel}
                {ok ? ` · fica ${formatBRL(n.totalAfterCents)}` : ''}
                {n.decisionNote ? ` · “${n.decisionNote}”` : ''}
              </div>
            </div>
            <Button size="small" variant="plain" onClick={() => { seen(n.id); nav(mobile ? `/m/comanda/${n.comandaId}` : `/comandas/${n.comandaId}`); }}>Ver</Button>
            <Button size="small" variant="primary" onClick={() => seen(n.id)}>OK</Button>
          </div>
        );
      })}
    </div>
  );
}
