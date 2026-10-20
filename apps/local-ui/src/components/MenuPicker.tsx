import { presentationSuffix } from '@rupbar/core';
import { Check, Flame, Minus, Plus, Search, StickyNote, Trash2, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useBarcodeScanner } from '../lib/scanner';
import '../styles/menu.css';
import { Button, Empty, ErrorBox, Input, Loading, Modal, useToast } from './ui';

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
  /** Código de barras e código interno do produto (leitor no caixa). */
  barcode?: string | null;
  code?: string | null;
  available: number | null;
  soldOut: boolean;
  /** Escolhas pedidas ao tocar (sabor, energético, gelo…), na ordem. */
  optionGroupIds?: string[];
  /** Combos: quantas unidades da opção escolhida vão (5 gelos, 4 latas). */
  optionQty?: Record<string, number>;
  /** Meio a meio: as porções que podem ser metade (cobra a mais cara). */
  halfParts?: { presentationId: string; name: string; presentationName: string; priceCents: number; soldOut: boolean }[];
}
export interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  /** Metade do meio a meio: a opção mostra o preço da porção (não um acréscimo). */
  half?: boolean;
  choices: { id: string; name: string; priceDeltaCents: number; soldOut: boolean }[];
}
export interface Menu {
  categories: { id: string; name: string }[];
  items: MenuItem[];
  popular?: string[];
  optionGroups?: Record<string, OptionGroup>;
}
/** Opção escolhida num item do carrinho. */
export interface CartOption {
  groupId: string;
  choiceId: string;
  choice: string;
  priceDeltaCents: number;
  /** Metade do meio a meio: priceDeltaCents é o preço da porção inteira. */
  half?: boolean;
}
export interface CartLine {
  /** Produto + escolhas: o mesmo drink com energéticos diferentes vira linhas diferentes. */
  key: string;
  item: MenuItem;
  options: CartOption[];
  quantity: number;
  notes: string;
}

export const lineKey = (item: MenuItem, options: CartOption[]) => [item.presentationId, ...options.map((o) => o.choiceId)].join('|');
/** Preço da linha: meio a meio cobra a metade mais cara; as outras escolhas somam. */
export const unitPriceOf = (l: Pick<CartLine, 'item' | 'options'>) => {
  const halves = l.options.filter((o) => o.half).map((o) => o.priceDeltaCents);
  const base = halves.length ? Math.max(l.item.priceCents, ...halves) : l.item.priceCents;
  return base + l.options.filter((o) => !o.half).reduce((a, o) => a + o.priceDeltaCents, 0);
};
/** Menor preço possível (meio a meio com as duas metades mais baratas). */
export const fromPriceOf = (i: MenuItem) => (i.halfParts?.length ? Math.max(i.priceCents, Math.min(...i.halfParts.map((h) => h.priceCents))) : i.priceCents);

/** As duas metades do meio a meio viram dois grupos de escolha: 1ª e 2ª metade. */
export const halfGroups = (i: MenuItem): OptionGroup[] => (i.halfParts?.length
  ? [1, 2].map((n) => ({
      id: `half:${n}`, name: `${n}ª metade`, required: true, half: true,
      choices: i.halfParts!.map((h) => ({ id: h.presentationId, name: h.name, priceDeltaCents: h.priceCents, soldOut: h.soldOut })),
    }))
  : []);
export const optionsLabel = (options: CartOption[]) => options.map((o) => o.choice).join(' · ');

export const itemLabel = (i: { productName: string; presentationName: string }) =>
  presentationSuffix(i.productName, i.presentationName) ? `${i.productName} · ${i.presentationName}` : i.productName;

/**
 * Carrinho com identificador de envio estável: enquanto o conteúdo não muda,
 * reenviar (toque duplo, queda de rede) usa o mesmo id e não duplica nada.
 */
export function useCart() {
  const toast = useToast();
  const [lines, setLines] = useState<CartLine[]>([]);
  const requestKey = useRef<string | null>(null);
  /** Soma `delta` à linha do produto com estas escolhas (cria a linha se preciso). */
  const add = useCallback((item: MenuItem, delta: number, options: CartOption[] = []) => {
    requestKey.current = null;
    const key = lineKey(item, options);
    setLines((c) => {
      const line = c.find((l) => l.key === key);
      if (!line) return delta > 0 ? [...c, { key, item, options, quantity: delta, notes: '' }] : c;
      const quantity = Math.min(99, line.quantity + delta);
      const sameProduct = c.filter((l) => l.item.presentationId === item.presentationId).reduce((a, l) => a + l.quantity, 0) + delta;
      if (item.available !== null && delta > 0 && sameProduct > item.available) {
        toast.error(`Estoque disponível: ${item.available}`);
        return c;
      }
      return quantity <= 0 ? c.filter((l) => l !== line) : c.map((l) => (l === line ? { ...l, quantity } : l));
    });
  }, [toast]);
  /** Muda a quantidade de uma linha do carrinho (+1, −1, −tudo). */
  const changeLine = useCallback((key: string, delta: number) => {
    requestKey.current = null;
    setLines((c) => c.flatMap((l) => {
      if (l.key !== key) return [l];
      const quantity = Math.min(99, l.quantity + delta);
      return quantity <= 0 ? [] : [{ ...l, quantity }];
    }));
  }, []);
  /** Tira 1 do produto (a última linha dele), pelo "−" do bloco do cardápio. */
  const removeOne = useCallback((presentationId: string) => {
    requestKey.current = null;
    setLines((c) => {
      const idx = c.map((l) => l.item.presentationId).lastIndexOf(presentationId);
      if (idx < 0) return c;
      const l = c[idx]!;
      return l.quantity <= 1 ? c.filter((_, i) => i !== idx) : c.map((x, i) => (i === idx ? { ...x, quantity: x.quantity - 1 } : x));
    });
  }, []);
  const setNotes = useCallback((key: string, notes: string) => {
    requestKey.current = null;
    setLines((c) => c.map((l) => (l.key === key ? { ...l, notes } : l)));
  }, []);
  const clear = useCallback(() => {
    requestKey.current = null;
    setLines([]);
  }, []);
  const total = lines.reduce((a, l) => a + l.quantity * unitPriceOf(l), 0);
  const count = lines.reduce((a, l) => a + l.quantity, 0);
  const qtyOf = (id: string) => lines.filter((l) => l.item.presentationId === id).reduce((a, l) => a + l.quantity, 0);
  const payload = () => lines.map((l) => ({
    presentationId: l.item.presentationId, quantity: l.quantity, notes: l.notes || null,
    options: l.options.filter((o) => !o.half).map((o) => ({ groupId: o.groupId, choiceId: o.choiceId })),
    halves: l.options.filter((o) => o.half).map((o) => o.choiceId),
  }));
  return { lines, add, changeLine, removeOne, setNotes, clear, total, count, qtyOf, payload, requestKey };
}
export type Cart = ReturnType<typeof useCart>;

/** Cardápio em blocos grandes (toque para somar), com busca, categorias e mais vendidos. */
export function MenuPicker({ cart, compact, autoFocus }: { cart: Cart; compact?: boolean; autoFocus?: boolean }) {
  const toast = useToast();
  const { data: menu, error, reload } = useLoad(() => api.get<Menu>('/api/menu'));
  useRealtime('stock.changed', () => void reload());
  const [choosing, setChoosing] = useState<MenuItem | null>(null);
  const groupsOf = (item: MenuItem) => [...halfGroups(item), ...(item.optionGroupIds ?? []).map((g) => menu?.optionGroups?.[g]).filter((g): g is OptionGroup => !!g)];
  /** Toque no produto: com escolhas (sabor, energético, gelo), abre a escolha; sem, soma 1. */
  const pick = (item: MenuItem) => {
    if (groupsOf(item).length) setChoosing(item);
    else cart.add(item, 1);
  };

  /** Produto pelo código de barras ou código interno (o disponível primeiro). */
  const findByCode = (raw: string): MenuItem | null => {
    const code = raw.trim();
    if (!menu || !code) return null;
    const matches = menu.items.filter((i) => i.barcode === code || (!!i.code && i.code === code));
    return matches.find((i) => !i.soldOut) ?? matches[0] ?? null;
  };
  const addScanned = (item: MenuItem) => {
    if (item.soldOut) return toast.error(`${itemLabel(item)} está esgotado.`);
    if (groupsOf(item).length) return setChoosing(item);
    cart.add(item, 1);
    toast.success(`+1 ${itemLabel(item)}`);
  };
  // Leitor de código de barras: bipar o produto adiciona 1. Ticket de pedido (RB…) fica para a conferência.
  useBarcodeScanner((code) => {
    if (!menu || /^RB\d/i.test(code)) return false;
    const item = findByCode(code);
    if (item) addScanned(item);
    else toast.error(`Código ${code} não cadastrado. Cadastre em Produtos → Código de barras.`);
    return true;
  }, !!menu);
  const popular = menu?.popular ?? [];
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const effectiveCat = cat === 'popular' && popular.length === 0 ? 'all' : cat;

  const items = useMemo(() => {
    if (!menu) return [];
    const term = q.trim().toLowerCase();
    if (term) return menu.items.filter((i) => `${i.productName} ${i.presentationName}`.toLowerCase().includes(term) || i.barcode === q.trim() || (!!i.code && i.code === q.trim()));
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
        <Input
          placeholder="Buscar produto ou bipar o código…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} aria-label="Buscar produto"
          onKeyDown={(e) => {
            // Código digitado (ou leitor lento) + Enter: adiciona direto.
            if (e.key !== 'Enter') return;
            const item = findByCode(q);
            if (!item) return;
            e.preventDefault();
            addScanned(item);
            setQ('');
          }}
        />
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
                onClick={() => pick(i)}
                aria-label={`Adicionar ${itemLabel(i)} (${formatBRL(fromPriceOf(i))})`}
              >
                {i.photoUrl && <img className="menu-tile-photo" src={i.photoUrl} alt="" loading="lazy" />}
                <span className="menu-tile-name">{i.productName}</span>
                {presentationSuffix(i.productName, i.presentationName) && <span className="menu-tile-pres">{i.presentationName}</span>}
                <span className="menu-tile-price num">{groupsOf(i).length ? 'a partir de ' : ''}{formatBRL(fromPriceOf(i))}</span>
                {i.soldOut ? <span className="menu-tile-flag danger">Esgotado</span> : i.available !== null && i.available <= 5 ? <span className="menu-tile-flag">restam {i.available}</span> : null}
              </button>
              {n > 0 && (
                <>
                  <span className="menu-tile-qty pop-in" aria-hidden>{n}</span>
                  <button type="button" className="menu-tile-minus" aria-label={`Tirar um ${itemLabel(i)}`} onClick={() => cart.removeOne(i.presentationId)}><Minus size={16} /></button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {choosing && (
        <OptionChooser
          item={choosing}
          groups={groupsOf(choosing)}
          onClose={() => setChoosing(null)}
          onAdd={(options) => {
            cart.add(choosing, 1, options);
            setChoosing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Escolhas do item (ex.: sabor do gin → energético → gelo): toque numa opção
 * de cada grupo. Opção única disponível já vem marcada; esgotadas não entram.
 */
export function OptionChooser({ item, groups, onClose, onAdd }: {
  item: MenuItem; groups: OptionGroup[]; onClose: () => void; onAdd: (options: CartOption[]) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const g of groups) {
      const available = g.choices.filter((c) => !c.soldOut);
      if (g.required && available.length === 1) init[g.id] = available[0]!.id;
    }
    return init;
  });
  const qtyOf = (g: OptionGroup) => item.optionQty?.[g.id] ?? 1;
  const options: CartOption[] = groups.flatMap((g) => {
    const c = g.choices.find((x) => x.id === picked[g.id]);
    const n = qtyOf(g);
    if (c && g.half) return [{ groupId: g.id, choiceId: c.id, choice: `½ ${c.name}`, priceDeltaCents: c.priceDeltaCents, half: true }];
    return c ? [{ groupId: g.id, choiceId: c.id, choice: n > 1 ? `${n}× ${c.name}` : c.name, priceDeltaCents: c.priceDeltaCents * n }] : [];
  });
  const missing = groups.filter((g) => g.required && !picked[g.id]);
  const price = unitPriceOf({ item, options });
  return (
    <Modal
      title={itemLabel(item)}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" size="large" disabled={missing.length > 0} icon={<Plus size={18} />} onClick={() => onAdd(options)}>
          {missing.length ? `Escolha ${missing[0]!.name.toLocaleLowerCase('pt-BR')}` : `Adicionar ${formatBRL(price)}`}
        </Button>
      </>}
    >
      <div className="option-chooser stack">
        {groups.some((g) => g.half) && <p className="small muted">Meio a meio: cobra o preço da metade mais cara.</p>}
        {groups.map((g) => (
          <div key={g.id} className="option-group" role="radiogroup" aria-label={g.name}>
            <div className="option-group-title">
              <strong>{g.name}</strong>
              {qtyOf(g) > 1 && <span className="option-qty">{qtyOf(g)}×</span>}
              <span className="tiny muted">{g.required ? 'obrigatório' : 'opcional'}</span>
            </div>
            <div className="option-choices">
              {g.choices.map((c) => {
                const on = picked[g.id] === c.id;
                return (
                  <button
                    key={c.id} type="button" role="radio" aria-checked={on} disabled={c.soldOut && !on}
                    className={`option-choice ${on ? 'active' : ''}`}
                    onClick={() => setPicked((p) => {
                      const next = { ...p };
                      if (on && !g.required) delete next[g.id];
                      else next[g.id] = c.id;
                      return next;
                    })}
                  >
                    {on && <Check size={16} />}
                    <span className="option-choice-name">{c.name}</span>
                    {c.soldOut ? <span className="tiny danger-text">esgotado</span> : g.half ? <span className="option-choice-price num">{formatBRL(c.priceDeltaCents)}</span> : c.priceDeltaCents > 0 ? <span className="option-choice-price num">+{formatBRL(c.priceDeltaCents * qtyOf(g))}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Itens escolhidos, com quantidade e observação. */
export function CartLines({ cart, empty = 'Toque nos produtos para adicionar.' }: { cart: Cart; empty?: string }) {
  const [noteFor, setNoteFor] = useState<string | null>(null);
  if (!cart.lines.length) return <div className="cart-empty small muted">{empty}</div>;
  return (
    <div className="cart-lines">
      {cart.lines.map((l) => (
        <div key={l.key} className="cart-line pop-in">
          <div className="row">
            <div className="stepper small">
              <button type="button" aria-label="Menos" onClick={() => cart.changeLine(l.key, -1)}><Minus size={14} /></button>
              <span>{l.quantity}</span>
              <button type="button" aria-label="Mais" onClick={() => cart.add(l.item, 1, l.options)}><Plus size={14} /></button>
            </div>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="ellipsis" style={{ display: 'block' }}>{itemLabel(l.item)}</span>
              {l.options.length > 0 && <span className="cart-line-options">{optionsLabel(l.options)}</span>}
            </span>
            <span className="num strong">{formatBRL(l.quantity * unitPriceOf(l))}</span>
            <Button size="small" variant="plain" icon={<StickyNote size={15} />} aria-label="Observação" onClick={() => setNoteFor(noteFor === l.key ? null : l.key)} />
            <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Remover" onClick={() => cart.changeLine(l.key, -l.quantity)} />
          </div>
          {(noteFor === l.key || l.notes) && (
            <Input
              style={{ marginTop: 6 }}
              placeholder="Observação (ex.: sem cebola, bem gelada)"
              maxLength={140}
              value={l.notes}
              autoFocus={noteFor === l.key}
              onChange={(e) => cart.setNotes(l.key, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
