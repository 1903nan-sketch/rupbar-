import { Bell, Check, ChefHat, Maximize2, Play, Printer, Truck, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Confirm, Empty, ErrorBox, Loading, Segmented, useToast } from '../components/ui';
import { api } from '../lib/api';
import { elapsed, fmtTime, minutesSince } from '../lib/format';
import { useLoad, useNow } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { chime } from './Tv';

interface Ticket {
  id: string;
  number: number;
  station: 'kitchen' | 'bar';
  status: 'received' | 'preparing' | 'ready' | 'delivered' | 'canceled';
  table: string | null;
  comandaNumber: number;
  customerFirstName: string;
  waiterName: string | null;
  notes: string | null;
  createdAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
  calledAt: string | null;
  callCount: number;
  items: { id: string; name: string; quantity: number; notes: string | null; canceled: boolean }[];
}

const COLUMNS: { status: Ticket['status']; label: string; color: string }[] = [
  { status: 'received', label: 'Recebidos', color: 'var(--blue)' },
  { status: 'preparing', label: 'Em preparo', color: 'var(--orange)' },
  { status: 'ready', label: 'Prontos', color: 'var(--green)' },
  { status: 'delivered', label: 'Entregues', color: 'var(--text-3)' },
  { status: 'canceled', label: 'Cancelados', color: 'var(--red)' },
];

const STATION_KEY = 'rupbar.kds.station';

export function KitchenPage() {
  const toast = useToast();
  const { can } = useSession();
  const now = useNow(20_000);
  const [station, setStation] = useState<'kitchen' | 'bar' | 'all'>(() => {
    try {
      return (localStorage.getItem(STATION_KEY) as 'kitchen' | 'bar' | 'all') ?? 'all';
    } catch {
      return 'all';
    }
  });
  const [sound, setSound] = useState(true);
  const [cancel, setCancel] = useState<Ticket | null>(null);
  const known = useRef<Set<string> | null>(null);
  const { data, error, reload } = useLoad(() => api.get<Ticket[]>(`/api/kitchen/board?station=${station}`), [station]);

  useEffect(() => {
    try {
      localStorage.setItem(STATION_KEY, station);
    } catch {
      /* armazenamento indisponível */
    }
    known.current = null;
  }, [station]);

  // Alerta sonoro para pedidos novos
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.map((t) => t.id));
    if (known.current && sound && data.some((t) => !known.current!.has(t.id) && t.status === 'received')) chime(2);
    known.current = ids;
  }, [data, sound]);

  useRealtime(['kitchen'], () => void reload());

  const act = async (t: Ticket, action: 'accept' | 'preparing' | 'ready' | 'delivered' | 'received' | 'call' | 'reprint') => {
    try {
      if (action === 'accept' || action === 'call' || action === 'reprint') {
        const r = await api.post(`/api/kitchen/tickets/${t.id}/${action}`);
        if (action === 'call') toast.success(`Chamando: ${r.text}`);
        if (action === 'reprint') toast.success('Reimpressão enviada');
      } else {
        await api.post(`/api/kitchen/tickets/${t.id}/status`, { status: action });
      }
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const fullscreen = () => document.documentElement.requestFullscreen?.().catch(() => undefined);

  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="row">
          <ChefHat size={26} />
          <h1>Produção</h1>
        </div>
        <div className="row wrap">
          <Segmented value={station} onChange={setStation} options={[{ value: 'all', label: 'Todos' }, { value: 'kitchen', label: 'Cozinha' }, { value: 'bar', label: 'Bebidas' }]} />
          <Button variant={sound ? 'default' : 'plain'} icon={<Volume2 size={16} />} onClick={() => setSound(!sound)}>{sound ? 'Som ligado' : 'Som desligado'}</Button>
          <Button icon={<Maximize2 size={16} />} onClick={fullscreen} aria-label="Tela cheia" />
        </div>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        <Loading />
      ) : (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const tickets = data.filter((t) => t.status === col.status);
            const ordered = col.status === 'delivered' || col.status === 'canceled' ? [...tickets].reverse() : tickets;
            return (
              <div key={col.status} className="column">
                <div className="column-head">
                  <span className="row"><span className="dot" style={{ background: col.color }} />{col.label}</span>
                  <Badge>{tickets.length}</Badge>
                </div>
                {ordered.length === 0 && <Empty title="" />}
                {ordered.map((t) => {
                  const wait = minutesSince(t.createdAt, now);
                  const active = t.status === 'received' || t.status === 'preparing';
                  const cls = active && wait >= 25 ? 'late' : active && wait >= 15 ? 'warn' : '';
                  return (
                    <article key={t.id} className={`ticket ${cls}`} style={{ borderLeftColor: !cls ? col.color : undefined }}>
                      <div className="row between">
                        <span className="number">#{t.number}</span>
                        <span className={`small strong ${cls === 'late' ? 'danger-text' : cls === 'warn' ? 'warning-text' : 'muted'}`}>{active ? elapsed(t.createdAt, now) : fmtTime(t.readyAt ?? t.createdAt)}</span>
                      </div>
                      <div className="small muted">
                        {t.customerFirstName}{t.table ? ` · Mesa ${t.table}` : ` · Comanda ${t.comandaNumber}`} · {fmtTime(t.createdAt)}
                        {station === 'all' && <> · {t.station === 'kitchen' ? 'Cozinha' : 'Bebidas'}</>}
                      </div>
                      <ul>
                        {t.items.map((i) => (
                          <li key={i.id} className={i.canceled ? 'canceled' : ''}>
                            <span className="qty">{i.quantity}×</span>{i.name}
                            {i.notes && <div className="note">↳ {i.notes}</div>}
                          </li>
                        ))}
                      </ul>
                      {t.notes && <div className="note">Obs.: {t.notes}</div>}
                      {t.waiterName && <div className="tiny subtle">Atendente: {t.waiterName}{t.callCount > 0 && ` · chamado ${t.callCount}×`}</div>}
                      {can('kitchen.update') && (
                        <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
                          {t.status === 'received' && !t.acceptedAt && <Button size="small" icon={<Check size={14} />} onClick={() => act(t, 'accept')}>Aceitar</Button>}
                          {t.status === 'received' && <Button size="small" variant="primary" icon={<Play size={14} />} onClick={() => act(t, 'preparing')}>Iniciar</Button>}
                          {t.status === 'preparing' && <Button size="small" variant="success" icon={<Check size={14} />} onClick={() => act(t, 'ready')}>Pronto</Button>}
                          {(t.status === 'ready' || t.status === 'preparing') && can('kitchen.call') && (
                            <Button size="small" variant="primary" icon={<Bell size={14} />} onClick={() => act(t, 'call')}>{t.callCount ? 'Chamar de novo' : 'Chamar cliente'}</Button>
                          )}
                          {t.status === 'ready' && <Button size="small" icon={<Truck size={14} />} onClick={() => act(t, 'delivered')}>Entregue</Button>}
                          {t.status === 'delivered' && <Button size="small" onClick={() => act(t, 'ready')}>Desfazer</Button>}
                          <Button size="small" variant="plain" icon={<Printer size={14} />} aria-label="Reimprimir" onClick={() => act(t, 'reprint')} />
                          {active && <Button size="small" variant="plain" icon={<X size={14} />} aria-label="Cancelar" onClick={() => setCancel(t)} />}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {cancel && (
        <Confirm title={`Cancelar pedido #${cancel.number}?`} danger confirmLabel="Cancelar pedido" onClose={() => setCancel(null)}
          message="Para cancelar itens com devolução ao estoque e justificativa, use a comanda. Aqui o pedido apenas sai da fila de produção."
          onConfirm={async () => { await api.post(`/api/kitchen/tickets/${cancel.id}/status`, { status: 'canceled' }); await reload(); }} />
      )}
    </div>
  );
}
