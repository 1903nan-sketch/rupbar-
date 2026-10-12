import { ArrowLeft, ClipboardList, ListChecks, LogOut, Plus, Search, UserRound } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { ConnectionBanner, Logo } from '../../components/brand';
import { OrderComposer } from '../../components/OrderComposer';
import { Badge, Button, Empty, ErrorBox, Input, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { elapsed, fmtTime, formatBRL } from '../../lib/format';
import { useLoad, useNow } from '../../lib/hooks';
import { useRealtime } from '../../lib/realtime';
import { useSession } from '../../lib/session';
import { OpenComandaModal, type ComandaSummary } from '../Comandas';
import type { ComandaDetail } from '../ComandaDetail';

/** Layout do celular/tablet do garçom: barra superior e barra de abas inferior. */
export function MobileShell() {
  const { branding, user, logout } = useSession();
  return (
    <div className="mobile">
      <header className="mobile-top glass">
        <div className="row">
          <Logo branding={branding} size={30} />
          <strong className="grow ellipsis">{branding?.tradeName}</strong>
          <span className="small muted row"><UserRound size={14} /> {user?.name.split(' ')[0]}</span>
          <Button variant="plain" size="small" icon={<LogOut size={16} />} aria-label="Sair" onClick={() => void logout()} />
        </div>
      </header>
      <ConnectionBanner />
      <Outlet />
      <nav className="tabbar glass" style={{ ['--tabs' as string]: 2 }}>
        <NavLink to="/m" end className={({ isActive }) => (isActive ? 'active' : '')}><ClipboardList size={22} />Comandas</NavLink>
        <NavLink to="/m/pedidos" className={({ isActive }) => (isActive ? 'active' : '')}><ListChecks size={22} />Meus pedidos</NavLink>
      </nav>
    </div>
  );
}

export function MobileComandas() {
  const nav = useNavigate();
  const now = useNow(30_000);
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState(false);
  const { data, error, reload } = useLoad(() => api.get<ComandaSummary[]>(`/api/comandas?status=open${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q]);
  useRealtime('comandas', () => void reload());
  return (
    <div className="mobile-body">
      <div className="row">
        <div className="input-group grow"><Search size={16} className="prefix" /><Input placeholder="Mesa, nome ou número" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {can('comandas.open') && <Button variant="primary" icon={<Plus size={18} />} onClick={() => setOpening(true)}>Nova</Button>}
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? <Loading /> : data.length === 0 ? <Empty icon={<ClipboardList size={36} />} title="Nenhuma comanda aberta" /> : (
        <div className="col" style={{ gap: 10 }}>
          {data.map((c) => (
            <button key={c.id} type="button" className="menu-item" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => nav(`/m/comanda/${c.id}`)}>
              <div className="logo" style={{ width: 48, height: 48, fontSize: 16, borderRadius: 14 }}>{c.table ?? `#${c.number}`}</div>
              <div className="grow">
                <div className="strong">{c.customerName}</div>
                <div className="small muted">#{c.number} · {elapsed(c.openedAt, now)} · {c.itemCount} itens</div>
              </div>
              <span className="num strong">{formatBRL(c.total)}</span>
            </button>
          ))}
        </div>
      )}
      {opening && <OpenComandaModal onClose={() => setOpening(false)} onOpened={(id) => nav(`/m/comanda/${id}`)} />}
    </div>
  );
}

export function MobileComanda() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [view, setView] = useState<'menu' | 'conta'>('menu');
  const { data: c, error, reload } = useLoad(() => api.get<ComandaDetail>(`/api/comandas/${id}`), [id]);
  useRealtime(['comanda.changed', 'order.status'], () => void reload());
  if (error) return <div className="mobile-body"><ErrorBox error={error} onRetry={reload} /></div>;
  if (!c) return <Loading />;
  return (
    <div className="mobile-body" style={{ paddingBottom: 90 }}>
      <div className="row">
        <Button variant="plain" icon={<ArrowLeft size={20} />} aria-label="Voltar" onClick={() => nav('/m')} />
        <div className="grow">
          <div className="strong">{c.customerName}</div>
          <div className="small muted">#{c.number}{c.table && ` · Mesa ${c.table}`} · {formatBRL(c.total)}</div>
        </div>
      </div>
      <div className="segmented" style={{ alignSelf: 'stretch', display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        <button type="button" className={view === 'menu' ? 'active' : ''} onClick={() => setView('menu')}>Cardápio</button>
        <button type="button" className={view === 'conta' ? 'active' : ''} onClick={() => setView('conta')}>Itens da comanda</button>
      </div>
      {c.status !== 'open' ? (
        <div className="banner warning">Esta comanda foi encerrada.</div>
      ) : view === 'menu' ? (
        <OrderComposer comandaId={c.id} compact onSent={() => { void reload(); }} />
      ) : (
        <div className="col" style={{ gap: 8 }}>
          {c.items.filter((i) => i.status === 'active').length === 0 && <Empty title="Nenhum item ainda" />}
          {c.items.filter((i) => i.status === 'active').map((i) => (
            <div key={i.id} className="menu-item">
              <span className="strong num">{i.quantity}×</span>
              <div className="grow">
                <div>{i.name}{i.presentationName !== 'Unidade' && <span className="muted"> · {i.presentationName}</span>}</div>
                <div className="tiny muted">Pedido {i.orderNumber ?? '—'} · {fmtTime(i.createdAt)}{i.notes && ` · ${i.notes}`}</div>
              </div>
              {i.ticketStatus && <TicketBadge status={i.ticketStatus} />}
            </div>
          ))}
          <div className="card tight row between"><span className="muted">Total</span><strong className="num">{formatBRL(c.total)}</strong></div>
        </div>
      )}
    </div>
  );
}

function TicketBadge({ status }: { status: string }) {
  const map: Record<string, [string, 'green' | 'orange' | 'blue' | 'red' | undefined]> = {
    received: ['Recebido', 'blue'], preparing: ['Em preparo', 'orange'], ready: ['Pronto', 'green'], delivered: ['Entregue', undefined], canceled: ['Cancelado', 'red'],
  };
  const [label, color] = map[status] ?? [status, undefined];
  return <Badge color={color}>{label}</Badge>;
}

export function MobileOrders() {
  const now = useNow(20_000);
  const { data, reload } = useLoad(() => api.get<{ id: string; number: number; comandaNumber: number; table: string | null; customerFirstName: string; createdAt: string; tickets: { station: string; status: string }[]; items: { id: string; product_name: string; presentation_name: string; quantity: number; status: string }[] }[]>('/api/orders/mine'));
  useRealtime(['order.status', 'order.created', 'comandas'], () => void reload());
  if (!data) return <Loading />;
  return (
    <div className="mobile-body">
      <h2>Meus pedidos</h2>
      {data.length === 0 && <Empty icon={<ListChecks size={36} />} title="Você ainda não enviou pedidos" />}
      {data.map((o) => (
        <div key={o.id} className="card tight">
          <div className="row between">
            <strong style={{ fontSize: 18 }}>Pedido {o.number}</strong>
            <span className="small muted">{elapsed(o.createdAt, now)}</span>
          </div>
          <div className="small muted">{o.customerFirstName} · comanda #{o.comandaNumber}{o.table && ` · mesa ${o.table}`}</div>
          <div className="row wrap" style={{ margin: '8px 0', gap: 6 }}>
            {o.tickets.map((t) => <span key={t.station} className="row small">{t.station === 'kitchen' ? 'Cozinha' : 'Bebidas'}: <TicketBadge status={t.status} /></span>)}
          </div>
          <div className="small">{o.items.filter((i) => i.status === 'active').map((i) => `${i.quantity}× ${i.product_name}${i.presentation_name !== 'Unidade' ? ` (${i.presentation_name})` : ''}`).join(' · ')}</div>
        </div>
      ))}
    </div>
  );
}
