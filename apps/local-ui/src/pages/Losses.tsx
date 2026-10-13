import { BASE_UNIT, LOSS_REASONS, LOSS_STATUS, toMilli, UNITS, unitsFor, type LossReason, type LossStatus, type Measure } from '@rupbar/core';
import { Cloud, PackageMinus, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Textarea, useToast } from '../components/ui';
import { api, requestId } from '../lib/api';
import { fmtDateTime, formatBRL, formatQty } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import type { Product } from './Products';
import { ReasonModal } from '../components/OwnerActions';

interface Loss {
  id: string;
  productName: string;
  measure: Measure;
  categoryName: string;
  qty: number;
  appliedQty: number;
  unit: string;
  reason: LossReason;
  reasonLabel: string;
  notes: string | null;
  occurredAt: string;
  registeredByName: string;
  source: 'local' | 'remote';
  status: LossStatus;
  costCents: number;
  attachmentId: string | null;
  resolutionNote: string | null;
  currentStock: number;
}

const STATUS_COLOR: Record<LossStatus, 'green' | 'orange' | 'red' | undefined> = {
  applied: 'green', pending_application: 'orange', conflict: 'red', rejected: undefined,
};

export function LossesPage() {
  const { can } = useSession();
  const [status, setStatus] = useState<'' | LossStatus>('');
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState<Loss | null>(null);
  const [deleting, setDeleting] = useState<Loss | null>(null);
  const { data, error, reload } = useLoad(() => api.get<Loss[]>(`/api/losses${status ? `?status=${status}` : ''}`), [status]);
  useRealtime(['stock', 'sync'], () => void reload());

  return (
    <div className="stack-l">
      <PageHeader
        title="Perdas"
        subtitle="Somente o proprietário registra e confirma perdas. Perdas do painel online são aplicadas aqui uma única vez."
        actions={can('losses.confirm') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>Registrar perda</Button>}
      />
      <Segmented value={status} onChange={setStatus} options={[{ value: '', label: 'Todas' }, { value: 'conflict', label: 'Conflitos' }, { value: 'applied', label: 'Aplicadas' }, { value: 'rejected', label: 'Rejeitadas' }]} />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? <Loading /> : data.length === 0 ? <Card><Empty icon={<PackageMinus size={40} />} title="Nenhuma perda" /></Card> : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Data</th><th>Produto</th><th className="right">Quantidade</th><th>Motivo</th><th>Responsável</th><th>Situação</th><th className="right">Custo</th><th /></tr></thead>
              <tbody>
                {data.map((l) => (
                  <tr key={l.id}>
                    <td className="small nowrap">{fmtDateTime(l.occurredAt)}</td>
                    <td><div>{l.productName}</div><div className="tiny muted">{l.categoryName}</div></td>
                    <td className="right num">{formatQty(l.qty, l.measure)}{l.status === 'applied' && l.appliedQty !== l.qty && <div className="tiny muted">aplicado {formatQty(l.appliedQty, l.measure)}</div>}</td>
                    <td>{l.reasonLabel}{l.notes && <div className="tiny muted">{l.notes}</div>}</td>
                    <td className="small">{l.registeredByName}{l.source === 'remote' && <span className="row tiny muted"><Cloud size={12} /> painel online</span>}</td>
                    <td><Badge color={STATUS_COLOR[l.status]}>{LOSS_STATUS[l.status]}</Badge>{l.resolutionNote && <div className="tiny muted" style={{ maxWidth: 240 }}>{l.resolutionNote}</div>}</td>
                    <td className="right num">{formatBRL(l.costCents)}</td>
                    <td className="right">
                      {l.status === 'conflict' && can('losses.confirm') && <Button size="small" variant="primary" onClick={() => setResolving(l)}>Resolver</Button>}
                      {l.attachmentId && <a className="btn plain small" href={`/api/files/${l.attachmentId}`} target="_blank" rel="noreferrer">Comprovante</a>}
                      {can('admin.override') && l.status !== 'rejected' && <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Excluir perda" title="Excluir (conta mestre)" onClick={() => setDeleting(l)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {creating && <LossModal onClose={() => setCreating(false)} onDone={reload} />}
      {deleting && (
        <ReasonModal title="Excluir perda" danger confirmLabel="Excluir perda" description="A quantidade baixada volta para o estoque. A perda fica no histórico como excluída."
          onClose={() => setDeleting(null)} onConfirm={async (reason) => { await api.post(`/api/admin/losses/${deleting.id}/delete`, { reason }); void reload(); }} />
      )}
      {resolving && <ResolveModal loss={resolving} onClose={() => setResolving(null)} onDone={reload} />}
    </div>
  );
}

function LossModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const products = useLoad(() => api.get<Product[]>('/api/products').then((ps) => ps.filter((p) => p.stockTracked)));
  const [productId, setProductId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [unit, setUnit] = useState('un');
  const [reason, setReason] = useState<LossReason>('broken');
  const [notes, setNotes] = useState('');
  const [when, setWhen] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);
  const p = products.data?.find((x) => x.id === productId);

  const submit = async () => {
    if (!p || !amount) return toast.error('Selecione o produto e a quantidade.');
    setBusy(true);
    try {
      let attachmentId: string | null = null;
      if (file) attachmentId = (await api.upload<{ id: string }>('/api/attachments?kind=loss_proof', file)).id;
      await api.post('/api/losses', {
        productId, qty: toMilli(amount, unit), unit, reason, notes: notes || null,
        occurredAt: when ? new Date(when).toISOString() : undefined, attachmentId, clientRequestId: rid,
      });
      toast.success('Perda registrada e baixada do estoque');
      onDone();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Registrar perda" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit}>Registrar perda</Button></>}>
      <div className="stack">
        <Field label="Produto *">
          <Select value={productId} onChange={(e) => { setProductId(e.target.value); const np = products.data?.find((x) => x.id === e.target.value); if (np) setUnit(BASE_UNIT[np.measure]); }}>
            <option value="">Selecione…</option>
            {products.data?.map((x) => <option key={x.id} value={x.id}>{x.name} — saldo {formatQty(x.stockQty, x.measure)}</option>)}
          </Select>
        </Field>
        <div className="grid-2">
          <Field label="Quantidade *"><DecimalInput value={amount} onChange={setAmount} /></Field>
          <Field label="Unidade">
            <Select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!p}>
              {(p ? unitsFor(p.measure) : [UNITS.un!]).map((u) => <option key={u.code} value={u.code}>{u.label} ({u.code})</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Motivo *">
          <Select value={reason} onChange={(e) => setReason(e.target.value as LossReason)}>
            {(Object.keys(LOSS_REASONS) as LossReason[]).map((r) => <option key={r} value={r}>{LOSS_REASONS[r]}</option>)}
          </Select>
        </Field>
        <Field label="Data e horário" hint="Em branco = agora."><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Observações"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <Field label="Comprovante (opcional)"><input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      </div>
    </Modal>
  );
}

function ResolveModal({ loss, onClose, onDone }: { loss: Loss; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [action, setAction] = useState<'apply_available' | 'apply_full' | 'reject'>('apply_available');
  const [note, setNote] = useState('');
  return (
    <Modal title="Resolver conflito de estoque" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={async () => {
      try { await api.post(`/api/losses/${loss.id}/resolve`, { action, note }); toast.success('Conflito resolvido'); onDone(); onClose(); } catch (e) { toast.error(e); }
    }}>Confirmar</Button></>}>
      <div className="stack">
        <div className="banner danger">A perda informada no painel online ({formatQty(loss.qty, loss.measure)} de {loss.productName}) é maior que o saldo atual ({formatQty(loss.currentStock, loss.measure)}). Nada foi baixado até agora.</div>
        <label className="check"><input type="radio" checked={action === 'apply_available'} onChange={() => setAction('apply_available')} /><span><strong>Aplicar até o saldo disponível</strong><div className="small muted">Baixa {formatQty(Math.min(loss.qty, Math.max(0, loss.currentStock)), loss.measure)} e zera o saldo.</div></span></label>
        <label className="check"><input type="radio" checked={action === 'apply_full'} onChange={() => setAction('apply_full')} /><span><strong>Aplicar a quantidade total</strong><div className="small muted">Somente se o saldo já foi corrigido (ex.: entrada registrada depois).</div></span></label>
        <label className="check"><input type="radio" checked={action === 'reject'} onChange={() => setAction('reject')} /><span><strong>Rejeitar</strong><div className="small muted">Não altera o estoque.</div></span></label>
        <Field label="Justificativa *"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
