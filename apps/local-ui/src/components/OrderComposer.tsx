import { Minus, Plus, Search, Send, StickyNote, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api, isOfflineError, requestId } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { Button, Empty, ErrorBox, Input, Loading, useToast } from './ui';

export interface MenuItem {
  presentationId: string;
  presentationName: string;
  priceCents: number;
  productId: string;
  productName: string;
  description: string | null;
  photoUrl: string | null;
  categoryId: string;
  station: string;
  available: number | null;
  soldOut: boolean;
}
interface Menu {
  categories: { id: string; name: string }[];
  items: MenuItem[];
}

interface CartLine {
  item: MenuItem;
  quantity: number;
  notes: string;
}

export const itemLabel = (i: { productName: string; presentationName: string }) =>
  i.presentationName === 'Unidade' ? i.productName : `${i.productName} · ${i.presentationName}`;

/**
 * Cardápio + carrinho para lançar pedidos (PC e celular).
 * O identificador do envio é gerado uma vez por carrinho: tocar de novo ou
 * reenviar após queda de conexão não duplica o pedido no servidor.
 */
export function OrderComposer({ comandaId, onSent, compact }: { comandaId: string; onSent: (order: { number: number }) => void; compact?: boolean }) {
  const toast = useToast();
  const { data: menu, error, reload } = useLoad(() => api.get<Menu>('/api/menu'));
  useRealtime('stock.changed', () => void reload());
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const pendingId = useRef<string | null>(null);

  const items = useMemo(() => {
    if (!menu) return [];
    const term = q.trim().toLowerCase();
    return menu.items.filter((i) => (cat === 'all' || i.categoryId === cat) && (!term || `${i.productName} ${i.presentationName}`.toLowerCase().includes(term)));
  }, [menu, cat, q]);

  const qtyOf = (id: string) => cart.find((l) => l.item.presentationId === id)?.quantity ?? 0;
  const change = (item: MenuItem, delta: number) => {
    pendingId.current = null; // o conteúdo mudou: novo envio
    setCart((c) => {
      const line = c.find((l) => l.item.presentationId === item.presentationId);
      if (!line) return delta > 0 ? [...c, { item, quantity: delta, notes: '' }] : c;
      const quantity = Math.min(99, line.quantity + delta);
      if (item.available !== null && delta > 0 && quantity > item.available) {
        toast.error(`Estoque disponível: ${item.available}`);
        return c;
      }
      return quantity <= 0 ? c.filter((l) => l !== line) : c.map((l) => (l === line ? { ...l, quantity } : l));
    });
  };
  const total = cart.reduce((a, l) => a + l.quantity * l.item.priceCents, 0);

  const send = async () => {
    if (!cart.length || sending) return;
    pendingId.current ??= requestId();
    setSending(true);
    try {
      const order = await api.post<{ number: number; duplicate: boolean }>(`/api/orders?source=${compact ? 'mobile' : 'desktop'}`, {
        comandaId,
        clientRequestId: pendingId.current,
        items: cart.map((l) => ({ presentationId: l.item.presentationId, quantity: l.quantity, notes: l.notes || null })),
      });
      toast.success(`Pedido ${order.number} enviado`);
      pendingId.current = null;
      setCart([]);
      onSent(order);
    } catch (e) {
      // Em falha de rede o mesmo id é mantido: reenviar é seguro.
      toast.error(isOfflineError(e) ? 'Sem conexão. Toque em "Enviar" novamente quando voltar — o pedido não será duplicado.' : e);
      if (!isOfflineError(e)) void reload();
    } finally {
      setSending(false);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!menu) return <Loading />;

  return (
    <div className="stack">
      <div className="input-group">
        <Search size={16} className="prefix" />
        <Input placeholder="Buscar no cardápio" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="scroll-x">
        <button type="button" className={`chip ${cat === 'all' ? 'active' : ''}`} onClick={() => setCat('all')}>Todos</button>
        {menu.categories.filter((c) => menu.items.some((i) => i.categoryId === c.id)).map((c) => (
          <button key={c.id} type="button" className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>
        ))}
      </div>
      <div className="col" style={{ gap: 8, maxHeight: compact ? undefined : '46vh', overflowY: compact ? undefined : 'auto' }}>
        {items.length === 0 && <Empty title="Nada encontrado" />}
        {items.map((i) => {
          const n = qtyOf(i.presentationId);
          return (
            <div key={i.presentationId} className="menu-item" style={{ opacity: i.soldOut ? 0.5 : 1 }}>
              {i.photoUrl ? <img className="thumb" src={i.photoUrl} alt="" loading="lazy" /> : null}
              <div className="grow">
                <div className="strong">{i.productName}</div>
                <div className="small muted">
                  {i.presentationName !== 'Unidade' && <>{i.presentationName} · </>}
                  <span className="num">{formatBRL(i.priceCents)}</span>
                  {i.soldOut ? <span className="danger-text"> · Esgotado</span> : i.available !== null && i.available <= 5 ? <span className="warning-text"> · restam {i.available}</span> : null}
                </div>
              </div>
              {n === 0 ? (
                <Button size="small" icon={<Plus size={16} />} disabled={i.soldOut} onClick={() => change(i, 1)} aria-label={`Adicionar ${i.productName}`} />
              ) : (
                <div className="stepper">
                  <button type="button" aria-label="Menos" onClick={() => change(i, -1)}><Minus size={15} /></button>
                  <span>{n}</span>
                  <button type="button" aria-label="Mais" onClick={() => change(i, 1)}><Plus size={15} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {cart.length > 0 && (
        <div className="card tight">
          <div className="section-label">Pedido</div>
          <div className="col" style={{ gap: 6 }}>
            {cart.map((l) => (
              <div key={l.item.presentationId}>
                <div className="row">
                  <span className="strong num" style={{ minWidth: 28 }}>{l.quantity}×</span>
                  <span className="grow ellipsis">{itemLabel(l.item)}</span>
                  <span className="num small muted">{formatBRL(l.quantity * l.item.priceCents)}</span>
                  <Button size="small" variant="plain" icon={<StickyNote size={15} />} aria-label="Observação" onClick={() => setNoteFor(noteFor === l.item.presentationId ? null : l.item.presentationId)} />
                  <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Remover" onClick={() => change(l.item, -l.quantity)} />
                </div>
                {(noteFor === l.item.presentationId || l.notes) && (
                  <Input
                    style={{ marginTop: 4 }}
                    placeholder="Observação (ex.: sem cebola, bem gelada)"
                    maxLength={140}
                    value={l.notes}
                    onChange={(e) => {
                      pendingId.current = null;
                      setCart((c) => c.map((x) => (x === l ? { ...x, notes: e.target.value } : x)));
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {compact ? (
        cart.length > 0 && (
          <div className="cart-bar">
            <div className="grow">
              <div className="small" style={{ opacity: 0.7 }}>{cart.reduce((a, l) => a + l.quantity, 0)} itens</div>
              <div className="strong num">{formatBRL(total)}</div>
            </div>
            <Button variant="primary" size="large" loading={sending} icon={<Send size={18} />} onClick={send}>Enviar</Button>
          </div>
        )
      ) : (
        <div className="row between">
          <span className="strong num">{cart.length ? `Total do pedido: ${formatBRL(total)}` : ''}</span>
          <Button variant="primary" size="large" disabled={!cart.length} loading={sending} icon={<Send size={18} />} onClick={send}>Enviar pedido</Button>
        </div>
      )}
    </div>
  );
}
