import { PAYMENT_METHODS, type PaymentMethod } from '@rupbar/core';
import { ArrowDownCircle, ArrowUpCircle, LockKeyhole, Paperclip, Pencil, RotateCcw, Trash2, Unlock, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, MoneyInput, PageHeader, Stat, Textarea, useToast } from '../components/ui';
import { api, requestId } from '../lib/api';
import { fmtDateTime, fmtTime, formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { OwnerTag, ReasonModal } from '../components/OwnerActions';

interface CashCurrent {
  open: boolean;
  defaultOpeningBalanceCents?: number;
  session?: { id: string; number: number; openedAt: string; openedByName: string; openingBalanceCents: number };
  summary?: { byMethod: Record<string, number>; totalSales: number; withdrawals: number; supplies: number; expectedCash: number } | null;
  movements?: Movement[];
}
interface Movement {
  id: string;
  type: 'withdrawal' | 'supply';
  amount_cents: number;
  reason: string;
  attachment_id: string | null;
  created_at: string;
  created_by_name: string;
  status?: 'active' | 'voided';
  void_reason?: string | null;
}
interface SessionView {
  id: string;
  number: number;
  status: 'open' | 'closed';
  openedAt: string;
  openedByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  openingBalanceCents: number;
  countedCashCents: number | null;
  expectedCashCents: number | null;
  differenceCents: number | null;
}

export function CashPage() {
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api.get<CashCurrent>('/api/cash/current'));
  useRealtime(['cash'], () => void reload());
  const [modal, setModal] = useState<null | 'open' | 'withdrawal' | 'supply' | 'close' | 'opening'>(null);
  const [fixMove, setFixMove] = useState<{ m: Movement; mode: 'edit' | 'delete' } | null>(null);
  const master = can('admin.override');

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  return (
    <div className="stack-l">
      <PageHeader
        title="Caixa"
        subtitle={data.open && data.session ? `Caixa nº ${data.session.number} aberto por ${data.session.openedByName} às ${fmtTime(data.session.openedAt)}` : 'Caixa fechado'}
        actions={
          data.open ? (
            <>
              {can('cash.withdrawal') && <Button icon={<ArrowUpCircle size={16} />} onClick={() => setModal('withdrawal')}>Sangria</Button>}
              {can('cash.supply') && <Button icon={<ArrowDownCircle size={16} />} onClick={() => setModal('supply')}>Suprimento</Button>}
              {master && <Button variant="plain" icon={<Pencil size={16} />} onClick={() => setModal('opening')}>Corrigir troco</Button>}
              {can('cash.close') && <Button variant="primary" icon={<LockKeyhole size={16} />} onClick={() => setModal('close')}>Fechar caixa</Button>}
            </>
          ) : (
            can('cash.open') && <Button variant="primary" icon={<Unlock size={16} />} onClick={() => setModal('open')}>Abrir caixa</Button>
          )
        }
      />
      {!data.open ? (
        <Card><Empty icon={<Wallet size={40} />} title="Caixa fechado">Abra o caixa informando o saldo inicial (troco) para começar a receber pagamentos.</Empty></Card>
      ) : (
        <>
          {data.summary && (
            <div className="grid-4">
              <Stat label="Saldo inicial" value={formatBRL(data.session!.openingBalanceCents)} />
              <Stat label="Recebido" value={formatBRL(data.summary.totalSales)} />
              <Stat label="Sangrias / suprimentos" value={<span className="small">−{formatBRL(data.summary.withdrawals)} / +{formatBRL(data.summary.supplies)}</span>} />
              <Stat label="Dinheiro esperado" value={formatBRL(data.summary.expectedCash)} />
            </div>
          )}
          {data.summary && (
            <Card title="Por forma de pagamento" flush>
              <div className="list">
                {Object.entries(data.summary.byMethod).length === 0 && <div className="list-item muted">Nenhum pagamento ainda.</div>}
                {Object.entries(data.summary.byMethod).map(([m, v]) => (
                  <div key={m} className="list-item"><span className="grow">{PAYMENT_METHODS[m as PaymentMethod] ?? m}</span><span className="num strong">{formatBRL(v)}</span></div>
                ))}
              </div>
            </Card>
          )}
          <Card title="Sangrias e suprimentos" flush>
            <div className="list">
              {data.movements?.length === 0 && <div className="list-item muted">Nenhuma movimentação.</div>}
              {data.movements?.map((m) => (
                <div key={m.id} className={`list-item ${m.status === 'voided' ? 'voided' : ''}`}>
                  {m.type === 'withdrawal' ? <Badge color="orange">Sangria</Badge> : <Badge color="blue">Suprimento</Badge>}
                  <div className="grow">
                    <div>{m.reason}</div>
                    <div className="tiny muted">{fmtDateTime(m.created_at)} · {m.created_by_name}</div>
                  </div>
                  {m.attachment_id && <a className="btn plain small" href={`/api/files/${m.attachment_id}`} target="_blank" rel="noreferrer"><Paperclip size={14} /> Comprovante</a>}
                  <span className="num strong">{m.type === 'withdrawal' ? '−' : '+'}{formatBRL(m.amount_cents)}</span>
                  {master && m.status !== 'voided' && (
                    <>
                      <Button size="small" variant="plain" icon={<Pencil size={15} />} aria-label="Corrigir" title="Corrigir (conta mestre)" onClick={() => setFixMove({ m, mode: 'edit' })} />
                      <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Excluir" title="Excluir (conta mestre)" onClick={() => setFixMove({ m, mode: 'delete' })} />
                    </>
                  )}
                  {m.status === 'voided' && <span className="tiny danger-text">{m.void_reason}</span>}
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
      {master && <PastSessions onChanged={reload} />}
      {modal === 'opening' && data.session && <CashSessionFix session={{ id: data.session.id, number: data.session.number, status: 'open', openingBalanceCents: data.session.openingBalanceCents, countedCashCents: null }} onClose={() => setModal(null)} onDone={reload} />}
      {fixMove && <MovementFix move={fixMove.m} mode={fixMove.mode} onClose={() => setFixMove(null)} onDone={reload} />}
      {modal === 'open' && <OpenCashModal defaultCents={data.defaultOpeningBalanceCents ?? 0} onClose={() => setModal(null)} onDone={reload} />}
      {(modal === 'withdrawal' || modal === 'supply') && <MovementModal type={modal} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'close' && <CloseCashModal expected={data.summary?.expectedCash ?? null} onClose={() => setModal(null)} onDone={reload} />}
    </div>
  );
}

function OpenCashModal({ defaultCents, onClose, onDone }: { defaultCents: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState<number | null>(defaultCents);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Abrir caixa" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={async () => {
      setBusy(true);
      try { await api.post('/api/cash/open', { openingBalanceCents: value ?? 0, notes: notes || null }); toast.success('Caixa aberto'); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Abrir caixa</Button></>}>
      <div className="stack">
        <Field label="Saldo inicial (dinheiro na gaveta)"><MoneyInput large autoFocus value={value} onChange={setValue} /></Field>
        <Field label="Observações"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function MovementModal({ type, onClose, onDone }: { type: 'withdrawal' | 'supply'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);
  const submit = async () => {
    if (!amount) return toast.error('Informe o valor.');
    setBusy(true);
    try {
      let attachmentId: string | null = null;
      if (file) attachmentId = (await api.upload<{ id: string }>('/api/attachments?kind=receipt', file)).id;
      await api.post('/api/cash/movements', { type, amountCents: amount, reason, attachmentId, clientRequestId: rid });
      toast.success(type === 'withdrawal' ? 'Sangria registrada' : 'Suprimento registrado');
      onDone();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={type === 'withdrawal' ? 'Sangria' : 'Suprimento'} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit}>Registrar</Button></>}>
      <div className="stack">
        <Field label="Valor"><MoneyInput large autoFocus value={amount} onChange={setAmount} /></Field>
        <Field label="Motivo *"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'withdrawal' ? 'Ex.: pagamento de fornecedor de gelo' : 'Ex.: reforço de troco'} /></Field>
        {type === 'withdrawal' && (
          <Field label="Comprovante (foto ou PDF da nota)" hint="Opcional. JPG, PNG, WEBP ou PDF até 10 MB.">
            <input type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        )}
        <p className="tiny muted">Depois de registrada, só o proprietário pode corrigir (com motivo, fica no histórico).</p>
      </div>
    </Modal>
  );
}

function CloseCashModal({ expected, onClose, onDone }: { expected: number | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [counted, setCounted] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const diff = counted !== null && expected !== null ? counted - expected : null;
  return (
    <Modal title="Fechar caixa" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={counted === null} onClick={async () => {
      setBusy(true);
      try {
        const r = await api.post<{ differenceCents: number }>('/api/cash/close', { countedCashCents: counted, notes: notes || null });
        toast.success(r.differenceCents === 0 ? 'Caixa fechado sem diferenças' : `Caixa fechado. Diferença: ${formatBRL(r.differenceCents)}`);
        onDone();
        onClose();
      } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Fechar caixa</Button></>}>
      <div className="stack">
        <Field label="Dinheiro contado na gaveta"><MoneyInput large autoFocus value={counted} onChange={setCounted} /></Field>
        {expected !== null && (
          <div className="card tight">
            <div className="row between"><span className="muted">Esperado</span><span className="num">{formatBRL(expected)}</span></div>
            {diff !== null && (
              <div className="row between"><span className="muted">{diff < 0 ? 'Falta' : diff > 0 ? 'Sobra' : 'Diferença'}</span><strong className={`num ${diff < 0 ? 'danger-text' : diff > 0 ? 'warning-text' : 'success-text'}`}>{formatBRL(Math.abs(diff))}</strong></div>
            )}
          </div>
        )}
        <Field label="Observações"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <p className="tiny muted">O fechamento registra quem fechou (pode ser diferente de quem abriu) e imprime o resumo nas impressoras de conta.</p>
      </div>
    </Modal>
  );
}

function MovementFix({ move, mode, onClose, onDone }: { move: Movement; mode: 'edit' | 'delete'; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState<number | null>(move.amount_cents);
  const [description, setDescription] = useState(move.reason);
  const label = move.type === 'withdrawal' ? 'sangria' : 'suprimento';
  if (mode === 'delete') {
    return (
      <ReasonModal title={`Excluir ${label}`} danger confirmLabel="Excluir" description={<>{formatBRL(move.amount_cents)} — {move.reason}. O caixa é recalculado.</>}
        onClose={onClose} onConfirm={async (reason) => { await api.post(`/api/admin/cash-movements/${move.id}/delete`, { reason }); onDone(); }} />
    );
  }
  return (
    <ReasonModal title={`Corrigir ${label}`} valid={!!amount && description.trim().length >= 3} onClose={onClose}
      onConfirm={async (reason) => { await api.put(`/api/admin/cash-movements/${move.id}`, { amountCents: amount, description, reason }); onDone(); }}>
      <Field label="Valor"><MoneyInput large value={amount} onChange={setAmount} /></Field>
      <Field label="Descrição"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </ReasonModal>
  );
}

function CashSessionFix({ session, onClose, onDone }: {
  session: { id: string; number: number; status: 'open' | 'closed'; openingBalanceCents: number; countedCashCents: number | null };
  onClose: () => void;
  onDone: () => void;
}) {
  const [opening, setOpening] = useState<number | null>(session.openingBalanceCents);
  const [counted, setCounted] = useState<number | null>(session.countedCashCents);
  return (
    <ReasonModal title={`Corrigir caixa nº ${session.number}`} valid={opening !== null} onClose={onClose}
      onConfirm={async (reason) => {
        await api.put(`/api/admin/cash-sessions/${session.id}`, { openingBalanceCents: opening, ...(session.status === 'closed' ? { countedCashCents: counted } : {}), reason });
        onDone();
      }}>
      <Field label="Saldo inicial (troco)"><MoneyInput large value={opening} onChange={setOpening} /></Field>
      {session.status === 'closed' && <Field label="Dinheiro contado no fechamento"><MoneyInput large value={counted} onChange={setCounted} /></Field>}
    </ReasonModal>
  );
}

/** Caixas anteriores: conferência e correções da conta mestre. */
function PastSessions({ onChanged }: { onChanged: () => void }) {
  const { data, reload } = useLoad(() => api.get<SessionView[]>('/api/cash/sessions'));
  const [fix, setFix] = useState<SessionView | null>(null);
  const [reopen, setReopen] = useState<SessionView | null>(null);
  const closed = (data ?? []).filter((s) => s.status === 'closed').slice(0, 15);
  if (!closed.length) return null;
  const done = () => { void reload(); onChanged(); };
  return (
    <Card title={<span className="row">Caixas anteriores <OwnerTag /></span>} flush>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Nº</th><th>Abertura</th><th>Fechamento</th><th className="right">Esperado</th><th className="right">Contado</th><th className="right">Diferença</th><th /></tr></thead>
          <tbody>
            {closed.map((s) => (
              <tr key={s.id}>
                <td className="strong">{s.number}</td>
                <td className="small">{fmtDateTime(s.openedAt)}<div className="tiny muted">{s.openedByName}</div></td>
                <td className="small">{fmtDateTime(s.closedAt)}<div className="tiny muted">{s.closedByName}</div></td>
                <td className="right num">{s.expectedCashCents !== null ? formatBRL(s.expectedCashCents) : '—'}</td>
                <td className="right num">{s.countedCashCents !== null ? formatBRL(s.countedCashCents) : '—'}</td>
                <td className={`right num strong ${(s.differenceCents ?? 0) < 0 ? 'danger-text' : (s.differenceCents ?? 0) > 0 ? 'warning-text' : 'success-text'}`}>{s.differenceCents !== null ? formatBRL(s.differenceCents) : '—'}</td>
                <td className="right nowrap">
                  <Button size="small" variant="plain" icon={<Pencil size={15} />} aria-label="Corrigir" onClick={() => setFix(s)} />
                  <Button size="small" variant="plain" icon={<RotateCcw size={15} />} aria-label="Reabrir" title="Reabrir caixa" onClick={() => setReopen(s)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fix && <CashSessionFix session={fix} onClose={() => setFix(null)} onDone={done} />}
      {reopen && (
        <ReasonModal title={`Reabrir caixa nº ${reopen.number}`} confirmLabel="Reabrir caixa" description="O caixa volta a ficar aberto para lançar ou corrigir pagamentos. Feche o caixa atual antes."
          onClose={() => setReopen(null)} onConfirm={async (reason) => { await api.post(`/api/admin/cash-sessions/${reopen.id}/reopen`, { reason }); done(); }} />
      )}
    </Card>
  );
}
