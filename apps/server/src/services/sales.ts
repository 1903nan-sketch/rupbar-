import { firstName, formatBRL } from '@rupbar/core';
import { quickSaleSchema } from '@rupbar/core/schemas';
import { badRequest } from '../lib/errors';
import type { CashService } from './cash';
import type { ComandasService } from './comandas';
import { requirePerm, type Actor, type Ctx } from './context';

/**
 * Venda rápida (balcão): o cliente pede, paga na hora e é chamado pelo nome
 * na TV quando o pedido fica pronto. Por baixo é uma comanda do tipo "quick"
 * aberta, lançada, paga e encerrada na mesma transação — relatórios, estoque,
 * caixa e produção funcionam igual às comandas normais.
 */
export class SalesService {
  /**
   * Depois do pagamento: ticket do pedido no caixa (o cliente leva ao bar) e,
   * se pedido, o comprovante. Ligado em services/index.ts; devolve quantos
   * tickets foram para a fila.
   */
  /** printReceipt sem valor: vale o que ficou lembrado na venda rápida. */
  onCompleted: (info: { comandaId: string; orderId: string; printReceipt?: boolean }, actor: Actor) => number = () => 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly comandas: ComandasService,
    private readonly cash: CashService,
  ) {}

  quickSale(actor: Actor, raw: unknown) {
    requirePerm(actor, 'orders.create');
    requirePerm(actor, 'cash.payment');
    const input = quickSaleSchema.parse(raw);
    return this.ctx.tx(() => {
      const existing = this.ctx.db.get<{ id: string }>('SELECT id FROM comandas WHERE client_request_id = ?', input.clientRequestId);
      if (existing) return { ...this.view(existing.id), duplicate: true };

      const comandaId = this.comandas.openQuick(actor, input.customerName, input.clientRequestId, input.notes);
      const order = this.comandas.createOrder(actor, { comandaId, clientRequestId: this.ctx.id(), items: input.items, notes: input.notes }, 'quick');
      const total = this.comandas.totals(comandaId).total;
      const paying = input.payments.reduce((sum, p) => sum + p.amountCents, 0);
      if (paying !== total) {
        throw badRequest(`O pagamento (${formatBRL(paying)}) precisa ser igual ao total da venda (${formatBRL(total)}).`, 'PAYMENT_MISMATCH', { total });
      }
      let changeCents = 0;
      for (const p of input.payments) {
        const r = this.cash.pay(actor, { comandaId, clientRequestId: this.ctx.id(), ...p });
        changeCents += 'changeCents' in r ? Number(r.changeCents ?? 0) : 0;
      }
      const version = this.ctx.db.value<number>('SELECT version FROM comandas WHERE id = ?', comandaId)!;
      this.comandas.close(actor, comandaId, { expectedVersion: version });
      this.ctx.audit(actor, 'sales.quick', 'comanda', comandaId, { order: order.number, total, items: input.items.length });
      const tickets = this.onCompleted({ comandaId, orderId: String(order.id), printReceipt: input.printReceipt }, actor);
      return { ...this.view(comandaId), changeCents, ticketPrinted: tickets > 0, duplicate: false };
    });
  }

  private view(comandaId: string) {
    const c = this.ctx.db.get<{ number: number; customer_name: string }>('SELECT number, customer_name FROM comandas WHERE id = ?', comandaId)!;
    const order = this.ctx.db.get<{ id: string; number: number }>('SELECT id, number FROM orders WHERE comanda_id = ? ORDER BY created_at LIMIT 1', comandaId);
    const stations = order
      ? this.ctx.db.all<{ station: string }>('SELECT station FROM order_tickets WHERE order_id = ?', order.id).map((t) => t.station)
      : [];
    return {
      comandaId,
      saleNumber: c.number,
      orderId: order?.id ?? null,
      orderNumber: order?.number ?? null,
      customerName: c.customer_name,
      callName: firstName(c.customer_name),
      totalCents: this.comandas.totals(comandaId).total,
      /** Há itens para a cozinha/bar: o cliente aguarda a chamada na TV. */
      waitsForPickup: stations.length > 0,
    };
  }
}
