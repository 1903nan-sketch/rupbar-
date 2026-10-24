import { presentationSuffix } from '@rupbar/core';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, ClipboardList, Delete, ListChecks, LogOut, Plus, Search, UserRound, X, Zap } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ScreenErrorBoundary } from '../../lib/update';
import { ConnectionBanner, Logo } from '../../components/brand';
import { DiscountNotices } from '../../components/DiscountRequest';
import { OrderComposer } from '../../components/OrderComposer';
import { LaunchedItems } from '../../components/SwapItem';
import { Badge, Button, Empty, ErrorBox, Input, Loading, useToast } from '../../components/ui';
import { api, requestId } from '../../lib/api';
import { elapsed, formatBRL } from '../../lib/format';
import { useLoad, useNow } from '../../lib/hooks';
import { useRealtime } from '../../lib/realtime';
import { useSession } from '../../lib/session';
import '../../styles/mobile.css';
import { MobileCharge } from './MobileCharge';
import { MobileHookah } from './MobileHookah';
import { OpenComandaModal, type ComandaSummary } from '../Comandas';
import type { ComandaDetail } from '../ComandaDetail';

/** Layout do celular/tablet do garçom: barra superior e barra de abas inferior. */
export function MobileShell() {
  const { branding, user, logout, can } = useSession();
  const location = useLocation();
  const quick = can('orders.create') && can('cash.payment');
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
      <DiscountNotices mobile />
      <ScreenErrorBoundary key={location.pathname}>
        <Outlet />
      </ScreenErrorBoundary>
      <nav className="tabbar glass" style={{ ['--tabs' as string]: quick ? 3 : 2 }}>
        <NavLink to="/m" end className={({ isActive }) => (isActive ? 'active' : '')}><ClipboardList size={22} />Comandas</NavLink>
        {quick && <NavLink to="/m/venda" className={({ isActive }) => (isActive ? 'active' : '')}><Zap size={22} />Venda rápida</NavLink>}
        <NavLink to="/m/pedidos" className={({ isActive }) => (isActive ? 'active' : '')}><ListChecks size={22} />Pedidos</NavLink>
      </nav>
    </div>
  );
}

/**
 * Tela inicial do garçom: digita o número do cartão e vai direto para o
 * cardápio da comanda. Cartão livre abre a comanda na hora.
 */
export function MobileComandas() {
  const nav = useNavigate();
  const toast = useToast();
  const now = useNow(30_000);
  const { can } = useSession();
  const [digits, setDigits] = useState('');
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [showList, setShowList] = useState(false);
  const [opening, setOpening] = useState(false);
  const [free, setFree] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [openKey] = useState(requestId);
  const { data, error, reload } = useLoad(() => api.get<ComandaSummary[]>(`/api/comandas?status=open${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q]);
  useRealtime('comandas', () => void reload());

  const press = (k: string) => {
    setFree(null);
    setDigits((d) => (k === 'del' ? d.slice(0, -1) : (d + k).replace(/^0+/, '').slice(0, 5)));
  };
  const go = async () => {
    const n = Number(digits);
    if (!n) return;
    setBusy(true);
    try {
      const c = await api.get<ComandaSummary | null>(`/api/comandas/by-number/${n}`);
      if (c) nav(`/m/comanda/${c.id}`);
      else setFree(n);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const openCard = async () => {
    if (free === null) return;
    setBusy(true);
    try {
      const c = await api.post<ComandaSummary>('/api/comandas', { cardNumber: free, customerName: '', clientRequestId: openKey });
      nav(`/m/comanda/${c.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mobile-body">
      <section className="waiter-pad card">
        <div className="waiter-display" aria-live="polite">
          <span className="small muted">Nº da comanda</span>
          <span className="waiter-digits">{digits || '—'}</span>
        </div>
        <div className="waiter-keys">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => <button key={k} type="button" onClick={() => press(k)}>{k}</button>)}
          <button type="button" aria-label="Apagar" onClick={() => press('del')}><Delete size={22} /></button>
          <button type="button" onClick={() => press('0')}>0</button>
          <button type="button" className="go" aria-label="Abrir comanda" disabled={!digits || busy} onClick={() => void go()}><ArrowRight size={26} /></button>
        </div>
        {free !== null && (
          <div className="waiter-free pop-in">
            <span>Cartão <strong>{free}</strong> está livre.</span>
            {can('comandas.open') ? <Button variant="primary" loading={busy} onClick={openCard}>Abrir comanda {free}</Button> : <span className="small muted">Peça ao caixa para abrir.</span>}
          </div>
        )}
      </section>

      <div className="row between">
        <button type="button" className="mlist-toggle" onClick={() => setShowList(!showList)} aria-expanded={showList}>
          {showList ? <ChevronUp size={18} /> : <ChevronDown size={18} />} Comandas abertas ({data?.length ?? 0})
        </button>
        {showList && (
          <div className="row" style={{ gap: 4 }}>
            <Button size="small" variant="plain" icon={searching ? <X size={18} /> : <Search size={18} />} aria-label="Buscar" onClick={() => { setSearching(!searching); setQ(''); }} />
            {can('comandas.open') && <Button size="small" icon={<Plus size={16} />} onClick={() => setOpening(true)}>Nova</Button>}
          </div>
        )}
      </div>
      {showList && searching && <Input autoFocus placeholder="Nome ou mesa" value={q} onChange={(e) => setQ(e.target.value)} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!showList ? null : !data ? <Loading /> : data.length === 0 ? <Empty icon={<ClipboardList size={36} />} title="Nenhuma comanda aberta" /> : (
        <div className="waiter-grid stagger">
          {data.map((c) => (
            <button key={c.id} type="button" className="waiter-tile" onClick={() => nav(`/m/comanda/${c.id}`)}>
              <span className="waiter-tile-no">{c.displayNumber ?? c.number}</span>
              <span className="waiter-tile-name ellipsis">{c.customerName || (c.table ? `Mesa ${c.table}` : 'Sem nome')}</span>
              <span className="waiter-tile-meta">{elapsed(c.openedAt, now)} · {formatBRL(c.total)}</span>
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
  const { can } = useSession();
  const [params] = useSearchParams();
  const [view, setView] = useState<'lancar' | 'narguile' | 'cobrar'>(params.get('aba') === 'cobrar' ? 'cobrar' : 'lancar');
  const { data: c, error, reload } = useLoad(() => api.get<ComandaDetail>(`/api/comandas/${id}`), [id]);
  useRealtime(['comanda.changed', 'order.status'], () => void reload());
  if (error) return <div className="mobile-body"><ErrorBox error={error} onRetry={reload} /></div>;
  if (!c) return <Loading />;
  return (
    <div className="mobile-body mcomanda" style={{ paddingBottom: 110 }}>
      <div className="waiter-head">
        <Button variant="plain" icon={<ArrowLeft size={22} />} aria-label="Voltar" onClick={() => nav('/m')} />
        <span className="waiter-tile-no small">{c.displayNumber ?? c.number}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="strong ellipsis" style={{ fontSize: 17 }}>{c.customerName || (c.table ? `Mesa ${c.table}` : 'Sem nome')}</div>
          <div className="small muted">{formatBRL(c.total)}{c.paid > 0 && ` · falta ${formatBRL(c.remaining)}`}</div>
        </div>
      </div>
      {c.status !== 'open' ? (
        <div className="banner warning">Esta comanda foi encerrada.</div>
      ) : (
        <>
          <div className="mtabs" role="tablist" style={{ gridTemplateColumns: `repeat(${can('hookah.rent') ? 3 : 2}, minmax(0, 1fr))` }}>
            <button type="button" role="tab" aria-selected={view === 'lancar'} className={view === 'lancar' ? 'active' : ''} onClick={() => setView('lancar')}>Pedido</button>
            {can('hookah.rent') && <button type="button" role="tab" aria-selected={view === 'narguile'} className={view === 'narguile' ? 'active' : ''} onClick={() => setView('narguile')}>Narguilé</button>}
            <button type="button" role="tab" aria-selected={view === 'cobrar'} className={view === 'cobrar' ? 'active' : ''} onClick={() => setView('cobrar')}>Cobrar</button>
          </div>
          {view === 'lancar' && (
            <>
              <LaunchedItems items={c.items} onChanged={() => void reload()} />
              <OrderComposer comandaId={c.id} compact onSent={() => { void reload(); }} />
            </>
          )}
          {view === 'narguile' && <MobileHookah comandaId={c.id} onChanged={() => void reload()} />}
          {view === 'cobrar' && <MobileCharge comanda={c} onChanged={() => void reload()} onClosed={() => nav('/m')} />}
        </>
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

interface MyOrder {
  id: string;
  number: number;
  comandaNumber: number;
  comandaDisplayNumber: number | null;
  table: string | null;
  customerFirstName: string;
  customerDisplayName: string;
  createdAt: string;
  tickets: { station: string; status: string }[];
  items: { id: string; product_name: string; presentation_name: string; options_label?: string | null; quantity: number; status: string }[];
}

export function MobileOrders() {
  const now = useNow(20_000);
  const { data, reload } = useLoad(() => api.get<MyOrder[]>('/api/orders/mine'));
  useRealtime(['order.status', 'order.created', 'comandas', 'kitchen'], () => void reload());
  if (!data) return <Loading />;
  const rank = (o: MyOrder) => (o.tickets.some((t) => t.status === 'ready') ? 0 : o.tickets.some((t) => t.status === 'received' || t.status === 'preparing') ? 1 : 2);
  const sorted = [...data].sort((a, b) => rank(a) - rank(b));
  return (
    <div className="mobile-body">
      <h2>Meus pedidos</h2>
      {data.length === 0 && <Empty icon={<ListChecks size={36} />} title="Você ainda não enviou pedidos" />}
      {sorted.map((o) => {
        const ready = rank(o) === 0;
        return (
          <div key={o.id} className={`card tight waiter-order ${ready ? 'ready' : ''}`}>
            <div className="row between">
              <strong style={{ fontSize: 19 }}>{o.customerDisplayName || `Pedido ${o.number}`}</strong>
              {ready ? <Badge color="green">Pronto para levar</Badge> : <span className="small muted">{elapsed(o.createdAt, now)}</span>}
            </div>
            <div className="small muted">{o.comandaDisplayNumber !== null ? `Comanda ${o.comandaDisplayNumber}` : 'Venda rápida'}{o.table && ` · mesa ${o.table}`} · pedido {o.number}</div>
            <div className="row wrap" style={{ margin: '8px 0', gap: 6 }}>
              {o.tickets.map((t) => <span key={t.station} className="row small">{t.station === 'kitchen' ? 'Cozinha' : 'Bebidas'}: <TicketBadge status={t.status} /></span>)}
            </div>
            <div className="small">{o.items.filter((i) => i.status === 'active').map((i) => `${i.quantity}× ${i.product_name}${presentationSuffix(i.product_name, i.presentation_name) ? ` (${i.presentation_name})` : ''}${i.options_label ? ` — ${i.options_label}` : ''}`).join(' · ')}</div>
          </div>
        );
      })}
    </div>
  );
}
