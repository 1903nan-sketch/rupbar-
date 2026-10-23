import { ClipboardList, ClipboardPlus, CreditCard, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Segmented, Select, useToast } from '../components/ui';
import { api, qs, requestId } from '../lib/api';
import { dayRange, elapsed, fmtDateTime, formatBRL } from '../lib/format';
import { useLoad, useNow } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { useShellActions } from '../layouts/DesktopShell';
import '../styles/comandas.css';

export interface ComandaSummary {
  id: string;
  number: number;
  cardNumber: number | null;
  kind: 'regular' | 'quick' | 'staff';
  displayNumber: number | null;
  label: string;
  customerName: string;
  table: string | null;
  status: 'open' | 'closed' | 'canceled';
  openedAt: string;
  closedAt: string | null;
  responsibleName: string | null;
  itemCount: number;
  total: number;
  paid: number;
  remaining: number;
  version: number;
}

export const STATUS_BADGE = {
  open: <Badge color="green">Aberta</Badge>,
  closed: <Badge>Encerrada</Badge>,
  canceled: <Badge color="red">Cancelada</Badge>,
};

export function ComandasPage() {
  const nav = useNavigate();
  const { can } = useSession();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<'open' | 'today' | 'all'>('open');
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState(false);
  const shell = useShellActions();
  const { data, error, reload } = useLoad(() => {
    const range = filter === 'today' ? dayRange(new Date()) : null;
    return api.get<ComandaSummary[]>(`/api/comandas${qs({ status: filter === 'open' ? 'open' : 'all', q, from: range?.from, to: range?.to })}`);
  }, [filter, q]);
  useRealtime('comandas', () => void reload());

  return (
    <div className="stack-l">
      <PageHeader
        title="Comandas"
        subtitle={data ? `${data.filter((c) => c.status === 'open').length} abertas` : undefined}
        actions={
          <>
            {can('orders.create') && <Button icon={<ClipboardPlus size={16} />} onClick={() => shell.openLaunch()}>Lançar pelo número</Button>}
            {can('comandas.open') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpening(true)}>Nova comanda</Button>}
          </>
        }
      />
      <div className="row wrap between">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'open', label: 'Abertas' }, { value: 'today', label: 'Hoje' }, { value: 'all', label: 'Todas' }]} />
        <div className="input-group" style={{ width: 300, maxWidth: '100%' }}>
          <Search size={16} className="prefix" />
          <Input placeholder="Nome, mesa ou nº do cartão" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><Empty icon={<ClipboardList size={40} />} title="Nenhuma comanda">{filter === 'open' ? 'Abra uma comanda para começar a lançar pedidos.' : 'Nada no período.'}</Empty></Card>
      ) : (
        <div className="comanda-grid stagger">
          {data.map((c) => (
            <button key={c.id} type="button" className={`card interactive comanda-card ${c.status}`} onClick={() => nav(`/comandas/${c.id}`)}>
              <div className="row between top">
                <span className={`comanda-no ${c.kind === 'quick' ? 'quick' : ''}`} title={c.label}>
                  {c.kind === 'quick' ? 'VR' : c.displayNumber ?? c.number}
                </span>
                <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                  {c.status === 'open' ? (c.table ? <Badge color="accent">Mesa {c.table}</Badge> : <Badge>Balcão</Badge>) : STATUS_BADGE[c.status]}
                  {c.kind === 'staff' && <Badge color="purple">Funcionário</Badge>}
                  {c.cardNumber !== null && <span className="tiny muted row" style={{ gap: 4 }}><CreditCard size={12} /> cartão</span>}
                </div>
              </div>
              <div className="strong ellipsis comanda-name">{c.customerName || (c.kind === 'quick' ? 'Venda rápida' : 'Sem nome')}</div>
              <div className="small muted">{c.status === 'open' ? `aberta há ${elapsed(c.openedAt, now)}` : fmtDateTime(c.closedAt ?? c.openedAt)} · {c.itemCount} {c.itemCount === 1 ? 'item' : 'itens'}</div>
              <div className="row between" style={{ marginTop: 12 }}>
                <span className="num strong" style={{ fontSize: 19 }}>{formatBRL(c.total)}</span>
                {c.paid > 0 && c.status === 'open' && <span className="small muted num">pago {formatBRL(c.paid)}</span>}
              </div>
              {c.status === 'open' && c.total > 0 && <div className="comanda-progress" aria-hidden><span style={{ width: `${Math.min(100, (c.paid / c.total) * 100)}%` }} /></div>}
            </button>
          ))}
        </div>
      )}
      {opening && <OpenComandaModal onClose={() => setOpening(false)} onOpened={(id) => nav(`/comandas/${id}`)} />}
    </div>
  );
}

export function OpenComandaModal({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const toast = useToast();
  const { user } = useSession();
  const staff = useLoad(() => api.get<{ id: string; name: string; role_name: string }[]>('/api/staff'));
  const [form, setForm] = useState({ cardNumber: '', customerName: '', customerPhone: '', customerCpf: '', table: '', responsibleUserId: user?.id ?? '' });
  const [who, setWho] = useState<'customer' | 'staff'>('customer');
  const [staffUserId, setStaffUserId] = useState('');
  const [showPersonal, setShowPersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);

  const submit = async () => {
    setBusy(true);
    try {
      const staffMode = who === 'staff';
      const c = await api.post<ComandaSummary>('/api/comandas', {
        cardNumber: form.cardNumber ? Number(form.cardNumber) : null,
        customerName: staffMode ? '' : form.customerName,
        customerPhone: staffMode ? null : form.customerPhone || null,
        customerCpf: staffMode ? null : form.customerCpf || null,
        table: staffMode ? null : form.table || null,
        responsibleUserId: form.responsibleUserId || undefined,
        ...(staffMode ? { staffUserId } : {}),
        clientRequestId: rid,
      });
      toast.success(`${c.label} aberta`);
      onClose();
      onOpened(c.id);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nova comanda"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={who === 'staff' ? !staffUserId : !form.customerName.trim() && !form.cardNumber} onClick={submit}>{who === 'staff' ? 'Abrir consumo' : 'Abrir comanda'}</Button></>}
    >
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Segmented value={who} onChange={setWho} options={[{ value: 'customer', label: 'Cliente' }, { value: 'staff', label: 'Funcionário' }]} />
        {who === 'staff' ? (
          <>
            <Field label="Funcionário" hint="Quem está pegando: baixa o estoque, não é cobrado e não entra nas vendas.">
              <Select value={staffUserId} aria-label="Funcionário que vai consumir" onChange={(e) => setStaffUserId(e.target.value)}>
                <option value="">Escolha…</option>
                {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Nº do cartão" hint="Opcional.">
              <Input inputMode="numeric" className="card-input" placeholder="—" value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: e.target.value.replace(/\D/g, '').slice(0, 5) })} />
            </Field>
          </>
        ) : (<>
        <div className="open-comanda-head">
          <Field label="Nº do cartão" hint="Opcional: o número impresso no cartão.">
            <Input autoFocus large inputMode="numeric" className="card-input" placeholder="—" value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: e.target.value.replace(/\D/g, '').slice(0, 5) })} />
          </Field>
          <Field label="Nome do cliente" hint={form.cardNumber ? 'Opcional com cartão.' : 'Obrigatório sem cartão.'}>
            <Input large value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} placeholder="Ex.: Mesa do Carlos" />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Mesa / identificação"><Input value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} placeholder="Ex.: 12, Varanda 3" /></Field>
          <Field label="Funcionário responsável">
            <Select value={form.responsibleUserId} onChange={(e) => setForm({ ...form, responsibleUserId: e.target.value })}>
              {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        {!showPersonal ? (
          <Button variant="plain" onClick={() => setShowPersonal(true)} style={{ alignSelf: 'flex-start' }}>Adicionar telefone ou CPF</Button>
        ) : (
          <>
            <div className="grid-2">
              <Field label="Telefone"><Input inputMode="tel" value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} placeholder="(11) 99999-9999" /></Field>
              <Field label="CPF" hint="Somente quando necessário."><Input inputMode="numeric" value={form.customerCpf} onChange={(e) => setForm({ ...form, customerCpf: e.target.value })} /></Field>
            </div>
            <p className="tiny muted">Dados pessoais ficam apenas neste PC, são exibidos mascarados e não vão para a nuvem, cupons ou TV (LGPD).</p>
          </>
        )}
        </>)}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
