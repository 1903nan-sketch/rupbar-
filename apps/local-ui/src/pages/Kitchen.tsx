import { Bell, Check, ChefHat, ChevronDown, ChevronUp, Maximize2, Minimize2, Play, Printer, Truck, Undo2, Volume2, VolumeX, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Confirm, ErrorBox, Loading, Segmented, useToast } from '../components/ui';
import { api } from '../lib/api';
import { elapsed, fmtTime, minutesSince } from '../lib/format';
import { useFullscreen } from '../lib/fullscreen';
import { useLoad, useNow } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { playAlert, soundUnlocked, unlockSound } from '../lib/sound';
import '../styles/kitchen.css';

interface Ticket {
  id: string;
  number: number;
  station: 'kitchen' | 'bar';
  status: 'received' | 'preparing' | 'ready' | 'delivered' | 'canceled';
  table: string | null;
  comandaNumber: number;
  comandaKind: 'regular' | 'quick';
  comandaDisplayNumber: number | null;
  customerFirstName: string;
  customerDisplayName: string;
  waiterName: string | null;
  notes: string | null;
  createdAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
  calledAt: string | null;
  callCount: number;
  items: { id: string; name: string; options?: string | null; quantity: number; notes: string | null; canceled: boolean }[];
}

const ACTIVE: { status: Ticket['status']; label: string; tone: string }[] = [
  { status: 'received', label: 'Novos', tone: 'blue' },
  { status: 'preparing', label: 'Em preparo', tone: 'orange' },
  { status: 'ready', label: 'Prontos', tone: 'green' },
];

const PREFS_KEY = 'rupbar.kds.prefs';
type Prefs = { station: 'kitchen' | 'bar' | 'all'; sound: boolean; repeat: number; big: boolean };
function loadPrefs(): Prefs {
  const base: Prefs = { station: 'all', sound: true, repeat: 2, big: false };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return base;
  }
}

export function KitchenPage() {
  const toast = useToast();
  const { can } = useSession();
  const now = useNow(15_000);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [unlocked, setUnlocked] = useState(soundUnlocked);
  const [showDone, setShowDone] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [cancel, setCancel] = useState<Ticket | null>(null);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const known = useRef<Set<string> | null>(null);
  const { data, error, reload } = useLoad(() => api.get<Ticket[]>(`/api/kitchen/board?station=${prefs.station}`), [prefs.station]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* armazenamento indisponível */
    }
  }, [prefs]);
  useEffect(() => {
    known.current = null;
  }, [prefs.station]);

  // Pedido novo: alerta alto + destaque piscando por alguns segundos.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.map((t) => t.id));
    if (known.current) {
      const novos = data.filter((t) => !known.current!.has(t.id) && t.status === 'received').map((t) => t.id);
      if (novos.length) {
        if (prefs.sound) setUnlocked(playAlert('order', { times: prefs.repeat }));
        setFresh((f) => new Set([...f, ...novos]));
        setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !novos.includes(id)))), 12_000);
      }
    }
    known.current = ids;
  }, [data, prefs.sound, prefs.repeat]);

  useRealtime(['kitchen'], () => void reload());

  const act = async (t: Ticket, action: 'accept' | 'preparing' | 'ready' | 'delivered' | 'received' | 'call' | 'reprint') => {
    try {
      if (action === 'accept' || action === 'call' || action === 'reprint') {
        const r = await api.post(`/api/kitchen/tickets/${t.id}/${action}`);
        if (action === 'call') toast.success(`Chamando na TV: ${r.text}`);
        if (action === 'reprint') toast.success('Reimpressão enviada');
      } else {
        await api.post(`/api/kitchen/tickets/${t.id}/status`, { status: action });
      }
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const done = (data ?? []).filter((t) => t.status === 'delivered' || t.status === 'canceled').reverse();

  return (
    <div className={`kds stack ${prefs.big ? 'big' : ''}`} onPointerDown={() => { if (!unlocked) void unlockSound().then(setUnlocked); }}>
      <div className="kds-head">
        <div className="row">
          <span className="icon-chip"><ChefHat size={22} /></span>
          <div>
            <h1>Produção</h1>
            <div className="small muted">{data ? `${data.filter((t) => t.status === 'received' || t.status === 'preparing').length} em andamento · ${data.filter((t) => t.status === 'ready').length} prontos` : ' '}</div>
          </div>
        </div>
        <div className="row wrap">
          <Segmented value={prefs.station} onChange={(station) => setPrefs({ ...prefs, station })} options={[{ value: 'all', label: 'Todos' }, { value: 'kitchen', label: 'Cozinha' }, { value: 'bar', label: 'Bebidas' }]} />
          <Segmented value={String(prefs.repeat)} onChange={(v) => setPrefs({ ...prefs, repeat: Number(v) })} options={[{ value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '3', label: '3×' }]} />
          <Button variant={prefs.sound ? 'default' : 'plain'} icon={prefs.sound ? <Volume2 size={16} /> : <VolumeX size={16} />} onClick={() => { setPrefs({ ...prefs, sound: !prefs.sound }); void unlockSound().then(setUnlocked); }}>
            {prefs.sound ? 'Som alto' : 'Sem som'}
          </Button>
          <Button variant="plain" onClick={() => { void unlockSound().then(setUnlocked); playAlert('order', { times: 1 }); }}>Testar som</Button>
          <Button variant="plain" onClick={() => setPrefs({ ...prefs, big: !prefs.big })}>{prefs.big ? 'Letras normais' : 'Letras grandes'}</Button>
          <Button icon={fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />} onClick={toggleFullscreen} aria-label="Tela cheia" />
        </div>
      </div>

      {prefs.sound && !unlocked && <div className="banner warning kds-unlock">Toque em qualquer lugar desta tela para liberar o alerta sonoro.</div>}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        <Loading />
      ) : (
        <div className="kds-board">
          {ACTIVE.map((col) => {
            const tickets = data.filter((t) => t.status === col.status);
            return (
              <section key={col.status} className={`kds-col ${col.tone}`}>
                <header className="kds-col-head">
                  <span className="row"><span className={`dot ${col.tone}`} />{col.label}</span>
                  <span className="kds-count">{tickets.length}</span>
                </header>
                <div className="kds-col-body">
                  {tickets.length === 0 && <div className="kds-empty">Nenhum pedido</div>}
                  {tickets.map((t) => (
                    <TicketCard key={t.id} t={t} now={now} fresh={fresh.has(t.id)} showStation={prefs.station === 'all'} can={can} act={act} onCancel={() => setCancel(t)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {done.length > 0 && (
        <div className="kds-done">
          <button type="button" className="kds-done-toggle" onClick={() => setShowDone(!showDone)}>
            {showDone ? <ChevronUp size={16} /> : <ChevronDown size={16} />} Entregues e cancelados recentes ({done.length})
          </button>
          {showDone && (
            <div className="kds-done-list">
              {done.map((t) => (
                <div key={t.id} className={`kds-done-item ${t.status}`}>
                  <strong>{t.customerDisplayName || `Pedido ${t.number}`}</strong>
                  <span className="small muted">{t.comandaDisplayNumber !== null ? `Comanda ${t.comandaDisplayNumber}` : 'Venda rápida'} · {fmtTime(t.readyAt ?? t.createdAt)}</span>
                  <Badge color={t.status === 'canceled' ? 'red' : undefined}>{t.status === 'canceled' ? 'Cancelado' : 'Entregue'}</Badge>
                  {t.status === 'delivered' && can('kitchen.update') && <Button size="small" variant="plain" icon={<Undo2 size={14} />} onClick={() => act(t, 'ready')}>Desfazer</Button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {cancel && (
        <Confirm title={`Cancelar pedido de ${cancel.customerDisplayName || cancel.number}?`} danger confirmLabel="Cancelar pedido" onClose={() => setCancel(null)}
          message="Para cancelar itens com devolução ao estoque e justificativa, use a comanda. Aqui o pedido apenas sai da fila de produção."
          onConfirm={async () => { await api.post(`/api/kitchen/tickets/${cancel.id}/status`, { status: 'canceled' }); await reload(); }} />
      )}
    </div>
  );
}

function TicketCard({ t, now, fresh, showStation, can, act, onCancel }: {
  t: Ticket;
  now: number;
  fresh: boolean;
  showStation: boolean;
  can: (p: 'kitchen.update' | 'kitchen.call') => boolean;
  act: (t: Ticket, a: 'accept' | 'preparing' | 'ready' | 'delivered' | 'call' | 'reprint') => void;
  onCancel: () => void;
}) {
  const wait = minutesSince(t.createdAt, now);
  const active = t.status === 'received' || t.status === 'preparing';
  const level = active && wait >= 25 ? 'late' : active && wait >= 15 ? 'warn' : '';
  const quick = t.comandaKind === 'quick';
  return (
    <article className={`kds-ticket ${t.status} ${level} ${fresh ? 'fresh' : ''}`}>
      <header className="kds-ticket-head">
        <div className="kds-who">
          <div className="kds-name">{t.customerDisplayName || `Pedido ${t.number}`}</div>
          <div className="kds-meta">
            {quick ? <span className="kds-tag quick"><Zap size={12} /> Venda rápida</span> : <span className="kds-tag">Comanda {t.comandaDisplayNumber}</span>}
            {t.table && <span className="kds-tag">Mesa {t.table}</span>}
            {showStation && <span className="kds-tag subtle">{t.station === 'kitchen' ? 'Cozinha' : 'Bebidas'}</span>}
          </div>
        </div>
        <div className={`kds-timer ${level}`}>
          <span>{active ? elapsed(t.createdAt, now) : fmtTime(t.readyAt ?? t.createdAt)}</span>
          <span className="tiny">pedido {t.number}</span>
        </div>
      </header>
      <ul className="kds-items">
        {t.items.map((i) => (
          <li key={i.id} className={i.canceled ? 'canceled' : ''}>
            <span className="kds-qty">{i.quantity}</span>
            <span className="grow">
              {i.name}
              {i.options && <span className="kds-options">{i.options}</span>}
              {i.notes && <span className="kds-note">↳ {i.notes}</span>}
            </span>
          </li>
        ))}
      </ul>
      {t.notes && <div className="kds-note block">Obs.: {t.notes}</div>}
      {can('kitchen.update') && (
        <footer className="kds-actions">
          {t.status === 'received' && <Button variant="primary" block icon={<Play size={16} />} onClick={() => act(t, 'preparing')}>Começar</Button>}
          {t.status === 'preparing' && <Button variant="success" block icon={<Check size={16} />} onClick={() => act(t, 'ready')}>Pronto</Button>}
          {t.status === 'ready' && can('kitchen.call') && (
            <Button variant="primary" block icon={<Bell size={16} />} onClick={() => act(t, 'call')}>{t.callCount ? `Chamar de novo (${t.callCount}×)` : 'Chamar na TV'}</Button>
          )}
          <div className="row" style={{ gap: 4 }}>
            {t.status === 'received' && !t.acceptedAt && <Button size="small" icon={<Check size={14} />} onClick={() => act(t, 'accept')}>Visto</Button>}
            {t.status === 'preparing' && can('kitchen.call') && <Button size="small" icon={<Bell size={14} />} onClick={() => act(t, 'call')}>Chamar</Button>}
            {t.status === 'ready' && <Button size="small" icon={<Truck size={14} />} onClick={() => act(t, 'delivered')}>Entregue</Button>}
            <Button size="small" variant="plain" icon={<Printer size={14} />} aria-label="Reimprimir" onClick={() => act(t, 'reprint')} />
            {active && <Button size="small" variant="plain" icon={<X size={14} />} aria-label="Cancelar" onClick={onCancel} />}
          </div>
        </footer>
      )}
      {t.waiterName && <div className="tiny subtle">Atendente: {t.waiterName}</div>}
    </article>
  );
}
