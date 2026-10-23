import { presentationSuffix } from '@rupbar/core';
import { Repeat } from 'lucide-react';
import { useState } from 'react';
import { api, isOfflineError, requestId } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useSession } from '../lib/session';
import type { ComandaItem } from '../pages/ComandaDetail';
import { CartLines, MenuPicker, useCart, type Cart } from './MenuPicker';
import { Badge, Button, Modal, Segmented, Switch, useToast } from './ui';

const REASONS = ['Acabou', 'Cliente trocou', 'Lançado errado'] as const;

const itemText = (i: ComandaItem) => `${i.quantity}× ${i.name}${presentationSuffix(i.name, i.presentationName) ? ` · ${i.presentationName}` : ''}`;

/**
 * Trocar um item já lançado: lançou água e acabou → vai a com gás; outro
 * energético na dose. O item sai (volta ao estoque) e o escolhido entra num
 * pedido novo, que vai para a produção e a impressora. Para trocar só a
 * escolha, toque no mesmo produto e escolha de novo.
 */
export function SwapItemModal({ item, mobile, onClose, onDone }: { item: ComandaItem; mobile?: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const base = useCart();
  const [reason, setReason] = useState<(typeof REASONS)[number]>('Acabou');
  const [returnToStock, setReturnToStock] = useState(true);
  const [busy, setBusy] = useState(false);
  // O primeiro toque já entra com a mesma quantidade do item que sai (2 águas → 2 com gás).
  const cart: Cart = { ...base, add: (i, delta, options) => base.add(i, base.count === 0 && delta === 1 ? item.quantity : delta, options) };

  const submit = async () => {
    if (!cart.lines.length || busy) return;
    cart.requestKey.current ??= requestId();
    setBusy(true);
    try {
      const r = await api.post<{ number: number }>(`/api/comanda-items/${item.id}/swap?source=${mobile ? 'mobile' : 'desktop'}`, {
        clientRequestId: cart.requestKey.current, items: cart.payload(), reason, returnToStock,
      });
      toast.success(`Trocado: pedido ${r.number} enviado`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(isOfflineError(e) ? 'Sem conexão. Toque em "Trocar" de novo quando voltar — não duplica.' : e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Trocar item" wide onClose={onClose}
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="primary" icon={<Repeat size={16} />} loading={busy} disabled={!cart.lines.length} onClick={() => void submit()}>
          {cart.lines.length ? `Trocar · ${formatBRL(cart.total)}` : 'Escolha o novo item'}
        </Button>
      </>}>
      <div className="stack swap-item">
        <div className="banner swap-out">
          <Badge color="red">Sai</Badge>
          <span className="grow"><strong>{itemText(item)}</strong>{item.options && <span className="muted"> · {item.options}</span>}</span>
          <span className="num">{formatBRL(item.totalCents)}</span>
        </div>
        <div className="row wrap" style={{ gap: 12 }}>
          <Segmented value={reason} onChange={setReason} options={REASONS.map((r) => ({ value: r, label: r }))} />
          {can('comandas.cancel_item') && <Switch checked={returnToStock} onChange={setReturnToStock} label="Devolver ao estoque" />}
        </div>
        <p className="small muted">Toque no que entra no lugar{item.options ? ' (para trocar só a escolha, toque no mesmo produto e escolha de novo)' : ''}. Vai para a produção como um pedido novo.</p>
        <MenuPicker cart={cart} compact />
        {cart.lines.length > 0 && (
          <div className="card tight">
            <div className="section-label">Entra</div>
            <CartLines cart={cart} />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Itens já lançados, recolhidos no topo do pedido, com "Trocar" (celular do garçom). */
export function LaunchedItems({ items, onChanged }: { items: ComandaItem[]; onChanged: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [swapping, setSwapping] = useState<ComandaItem | null>(null);
  const active = items.filter((i) => i.status === 'active');
  if (!active.length) return null;
  const count = active.reduce((a, i) => a + i.quantity, 0);
  return (
    <div className="card tight launched-items">
      <button type="button" className="launched-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="section-label">Já lançados · {count} {count === 1 ? 'item' : 'itens'}</span>
        <span className="small accent-text">{open ? 'Fechar' : 'Ver e trocar'}</span>
      </button>
      {open && <div className="list">
        {active.map((i) => (
          <div key={i.id} className="list-item">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{itemText(i)}</div>
              {i.options && <div className="tiny accent-text">{i.options}</div>}
            </div>
            <span className="num small">{formatBRL(i.totalCents)}</span>
            {i.kind === 'product' && can('orders.create') && (
              <Button size="small" variant="plain" icon={<Repeat size={15} />} aria-label={`Trocar ${i.name}`} onClick={() => setSwapping(i)}>Trocar</Button>
            )}
          </div>
        ))}
      </div>}
      {swapping && <SwapItemModal item={swapping} mobile onClose={() => setSwapping(null)} onDone={onChanged} />}
    </div>
  );
}
