import { Flame, Minus, Plus, Search, StickyNote, Trash2, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import '../styles/menu.css';
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
export interface Menu {
  categories: { id: string; name: string }[];
  items: MenuItem[];
  popular?: string[];
}
export interface CartLine {
  item: MenuItem;
  quantity: number;
  notes: string;
}

export const itemLabel = (i: { productName: string; presentationName: string }) =>
  i.presentationName === 'Unidade' ? i.productName : `${i.productName} · ${i.presentationName}`;

/**
 * Carrinho com identificador de envio estável: enquanto o conteúdo não muda,
 * reenviar (toque duplo, queda de rede) usa o mesmo id e não duplica nada.
 */
export function useCart() {
  const toast = useToast();
  const [lines, setLines] = useState<CartLine[]>([]);
  const requestKey = useRef<string | null>(null);
  const add = useCallback((item: MenuItem, delta: number) => {
    requestKey.current = null;
    setLines((c) => {
      const line = c.find((l) => l.item.presentationId === item.presentationId);
      if (!line) return delta > 0 ? [...c, { item, quantity: delta, notes: '' }] : c;
      const quantity = Math.min(99, line.quantity + delta);
      if (item.available !== null && delta > 0 && quantity > item.available) {
        toast.error(`Estoque disponível: ${item.available}`);
        return c;
      }
      return quantity <= 0 ? c.filter((l) => l !== line) : c.map((l) => (l === line ? { ...l, quantity } : l));
    });
  }, [toast]);
  const setNotes = useCallback((presentationId: string, notes: string) => {
    requestKey.current = null;
    setLines((c) => c.map((l) => (l.item.presentationId === presentationId ? { ...l, notes } : l)));
  }, []);
  const clear = useCallback(() => {
    requestKey.current = null;
    setLines([]);
  }, []);
  const total = lines.reduce((a, l) => a + l.quantity * l.item.priceCents, 0);
  const count = lines.reduce((a, l) => a + l.quantity, 0);
  const qtyOf = (id: string) => lines.find((l) => l.item.presentationId === id)?.quantity ?? 0;
  const payload = () => lines.map((l) => ({ presentationId: l.item.presentationId, quantity: l.quantity, notes: l.notes || null }));
  return { lines, add, setNotes, clear, total, count, qtyOf, payload, requestKey };
}
export type Cart = ReturnType<typeof useCart>;

/** Cardápio em blocos grandes (toque para somar), com busca, categorias e mais vendidos. */
export function MenuPicker({ cart, compact, autoFocus }: { cart: Cart; compact?: boolean; autoFocus?: boolean }) {
  const { data: menu, error, reload } = useLoad(() => api.get<Menu>('/api/menu'));
  useRealtime('stock.changed', () => void reload());
  const popular = menu?.popular ?? [];
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const effectiveCat = cat === 'popular' && popular.length === 0 ? 'all' : cat;

  const items = useMemo(() => {
    if (!menu) return [];
    const term = q.trim().toLowerCase();
    if (term) return menu.items.filter((i) => `${i.productName} ${i.presentationName}`.toLowerCase().includes(term));
    if (effectiveCat === 'popular') {
      const order = new Map(popular.map((id, n) => [id, n]));
      return menu.items.filter((i) => order.has(i.presentationId)).sort((a, b) => order.get(a.presentationId)! - order.get(b.presentationId)!);
    }
    return menu.items.filter((i) => effectiveCat === 'all' || i.categoryId === effectiveCat);
  }, [menu, effectiveCat, q, popular]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!menu) return <Loading />;
  const cats = menu.categories.filter((c) => menu.items.some((i) => i.categoryId === c.id));

  return (
    <div className={`menu-picker ${compact ? 'compact' : ''}`}>
      <div className="menu-search input-group">
        <Search size={17} className="prefix" />
        <Input placeholder="Buscar produto…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} aria-label="Buscar produto" />
        {q && <button type="button" className="menu-search-clear" aria-label="Limpar busca" onClick={() => setQ('')}><X size={16} /></button>}
      </div>
      {!q && (
        <div className="scroll-x menu-cats" role="tablist" aria-label="Categorias">
          {popular.length > 0 && (
            <button type="button" role="tab" aria-selected={effectiveCat === 'popular'} className={`chip ${effectiveCat === 'popular' ? 'active' : ''}`} onClick={() => setCat('popular')}>
              <Flame size={14} /> Mais pedidos
            </button>
          )}
          <button type="button" role="tab" aria-selected={effectiveCat === 'all'} className={`chip ${effectiveCat === 'all' ? 'active' : ''}`} onClick={() => setCat('all')}>Todos</button>
          {cats.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={effectiveCat === c.id} className={`chip ${effectiveCat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>
          ))}
        </div>
      )}
      <div className="menu-grid">
        {items.length === 0 && <Empty title="Nada encontrado">Tente outro nome ou categoria.</Empty>}
        {items.map((i) => {
          const n = cart.qtyOf(i.presentationId);
          return (
            <div key={i.presentationId} className={`menu-tile ${n ? 'in-cart' : ''} ${i.soldOut ? 'sold-out' : ''}`}>
              <button
                type="button"
                className="menu-tile-main"
                disabled={i.soldOut}
                onClick={() => cart.add(i, 1)}
                aria-label={`Adicionar ${itemLabel(i)} (${formatBRL(i.priceCents)})`}
              >
                {i.photoUrl && <img className="menu-tile-photo" src={i.photoUrl} alt="" loading="lazy" />}
                <span className="menu-tile-name">{i.productName}</span>
                {i.presentationName !== 'Unidade' && <span className="menu-tile-pres">{i.presentationName}</span>}
                <span className="menu-tile-price num">{formatBRL(i.priceCents)}</span>
                {i.soldOut ? <span className="menu-tile-flag danger">Esgotado</span> : i.available !== null && i.available <= 5 ? <span className="menu-tile-flag">restam {i.available}</span> : null}
              </button>
              {n > 0 && (
                <>
                  <span className="menu-tile-qty pop-in" aria-hidden>{n}</span>
                  <button type="button" className="menu-tile-minus" aria-label={`Tirar um ${itemLabel(i)}`} onClick={() => cart.add(i, -1)}><Minus size={16} /></button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Itens escolhidos, com quantidade e observação. */
export function CartLines({ cart, empty = 'Toque nos produtos para adicionar.' }: { cart: Cart; empty?: string }) {
  const [noteFor, setNoteFor] = useState<string | null>(null);
  if (!cart.lines.length) return <div className="cart-empty small muted">{empty}</div>;
  return (
    <div className="cart-lines">
      {cart.lines.map((l) => (
        <div key={l.item.presentationId} className="cart-line pop-in">
          <div className="row">
            <div className="stepper small">
              <button type="button" aria-label="Menos" onClick={() => cart.add(l.item, -1)}><Minus size={14} /></button>
              <span>{l.quantity}</span>
              <button type="button" aria-label="Mais" onClick={() => cart.add(l.item, 1)}><Plus size={14} /></button>
            </div>
            <span className="grow ellipsis">{itemLabel(l.item)}</span>
            <span className="num strong">{formatBRL(l.quantity * l.item.priceCents)}</span>
            <Button size="small" variant="plain" icon={<StickyNote size={15} />} aria-label="Observação" onClick={() => setNoteFor(noteFor === l.item.presentationId ? null : l.item.presentationId)} />
            <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Remover" onClick={() => cart.add(l.item, -l.quantity)} />
          </div>
          {(noteFor === l.item.presentationId || l.notes) && (
            <Input
              style={{ marginTop: 6 }}
              placeholder="Observação (ex.: sem cebola, bem gelada)"
              maxLength={140}
              value={l.notes}
              autoFocus={noteFor === l.item.presentationId}
              onChange={(e) => cart.setNotes(l.item.presentationId, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
