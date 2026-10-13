import { Send } from 'lucide-react';
import { useState } from 'react';
import { api, isOfflineError, requestId } from '../lib/api';
import { formatBRL } from '../lib/format';
import { CartLines, itemLabel, MenuPicker, useCart, type MenuItem } from './MenuPicker';
import { Button, useToast } from './ui';

export { itemLabel, type MenuItem };

/**
 * Cardápio + carrinho para lançar pedidos numa comanda (PC e celular).
 * O identificador do envio é gerado uma vez por carrinho: tocar de novo ou
 * reenviar após queda de conexão não duplica o pedido no servidor.
 */
export function OrderComposer({ comandaId, onSent, compact }: { comandaId: string; onSent: (order: { number: number }) => void; compact?: boolean }) {
  const toast = useToast();
  const cart = useCart();
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!cart.lines.length || sending) return;
    cart.requestKey.current ??= requestId();
    setSending(true);
    try {
      const order = await api.post<{ number: number; duplicate: boolean }>(`/api/orders?source=${compact ? 'mobile' : 'desktop'}`, {
        comandaId,
        clientRequestId: cart.requestKey.current,
        items: cart.payload(),
      });
      toast.success(`Pedido ${order.number} enviado`);
      (window as unknown as { RupBarAndroid?: { vibrate?: (ms: number) => void } }).RupBarAndroid?.vibrate?.(40);
      cart.clear();
      onSent(order);
    } catch (e) {
      // Em falha de rede o mesmo id é mantido: reenviar é seguro.
      toast.error(isOfflineError(e) ? 'Sem conexão. Toque em "Enviar" novamente quando voltar — o pedido não será duplicado.' : e);
    } finally {
      setSending(false);
    }
  };

  if (compact) {
    return (
      <div className="stack">
        <MenuPicker cart={cart} compact />
        {cart.lines.length > 0 && (
          <div className="card tight">
            <div className="section-label">Pedido</div>
            <CartLines cart={cart} />
          </div>
        )}
        {cart.lines.length > 0 && (
          <div className="cart-bar glass pop-in">
            <div className="grow">
              <div className="small" style={{ opacity: 0.75 }}>{cart.count} {cart.count === 1 ? 'item' : 'itens'}</div>
              <div className="strong num" style={{ fontSize: 18 }}>{formatBRL(cart.total)}</div>
            </div>
            <Button variant="primary" size="large" loading={sending} icon={<Send size={18} />} onClick={send}>Enviar</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="composer">
      <MenuPicker cart={cart} autoFocus />
      <aside className="composer-cart">
        <div className="section-label">Pedido</div>
        <CartLines cart={cart} />
        <div className="composer-total">
          <span className="muted">Total</span>
          <span className="num strong">{formatBRL(cart.total)}</span>
        </div>
        <Button variant="primary" size="large" block disabled={!cart.lines.length} loading={sending} icon={<Send size={18} />} onClick={send}>Enviar pedido</Button>
      </aside>
    </div>
  );
}
