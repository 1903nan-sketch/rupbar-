import { canTransition, firstName, pickupAnnouncement, TICKET_STATUS, type TicketStatus } from '@rupbar/core';
import { ticketStatusSchema } from '@rupbar/core/schemas';
import type { Row } from '../db/db';
import { conflict, notFound } from '../lib/errors';
import { businessDay } from '../lib/time';
import { requirePerm, type Actor, type Ctx } from './context';
import type { SettingsService } from './settings';

const TIMESTAMP_COL: Partial<Record<TicketStatus, string>> = {
  preparing: 'preparing_at',
  ready: 'ready_at',
  delivered: 'delivered_at',
  canceled: 'canceled_at',
};

export class KitchenService {
  onReprint: (ticketId: string, actor: Actor) => void = () => {};

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
  ) {}

  private ticketRow(id: string): Row {
    const t = this.ctx.db.get('SELECT * FROM order_tickets WHERE id = ?', id);
    if (!t) throw notFound('Pedido');
    return t;
  }

  ticketView(t: Row) {
    const items = this.ctx.db.all(
      `SELECT id, product_name, presentation_name, quantity, notes, status FROM comanda_items
       WHERE order_id = ? AND station = ? ORDER BY created_at`,
      String(t.order_id), String(t.station),
    );
    return {
      id: t.id,
      orderId: t.order_id,
      number: t.number,
      station: t.station,
      status: t.status,
      statusLabel: TICKET_STATUS[t.status as TicketStatus],
      table: t.table_label,
      comandaNumber: t.comanda_number,
      customerFirstName: firstName(t.customer_name as string),
      waiterName: t.waiter_name,
      notes: t.order_notes,
      createdAt: t.created_at,
      acceptedAt: t.accepted_at,
      preparingAt: t.preparing_at,
      readyAt: t.ready_at,
      deliveredAt: t.delivered_at,
      calledAt: t.called_at,
      callCount: t.call_count,
      items: items.map((i) => ({
        id: i.id, name: i.presentation_name === 'Unidade' ? i.product_name : `${i.product_name} — ${i.presentation_name}`,
        quantity: i.quantity, notes: i.notes, canceled: i.status !== 'active',
      })),
    };
  }

  private baseQuery = `SELECT t.*, o.number, o.notes AS order_notes, c.table_label, c.number AS comanda_number, c.customer_name, u.name AS waiter_name
    FROM order_tickets t JOIN orders o ON o.id = t.order_id JOIN comandas c ON c.id = o.comanda_id LEFT JOIN users u ON u.id = o.created_by`;

  /**
   * Painel de produção. Mostra os pedidos ativos e os finalizados recentemente
   * (entregues/cancelados nas últimas `recentHours` horas).
   */
  board(actor: Actor, station: 'kitchen' | 'bar' | 'all', recentHours = 3) {
    requirePerm(actor, 'kitchen.view');
    const since = new Date(this.ctx.clock.now().getTime() - recentHours * 3_600_000).toISOString();
    const rows = this.ctx.db.all(
      `${this.baseQuery} WHERE (? = 'all' OR t.station = ?)
       AND (t.status IN ('received','preparing','ready') OR t.updated_at >= ?)
       ORDER BY t.created_at`,
      station, station, since,
    );
    return rows.map((t) => this.ticketView(t));
  }

  ticket(actor: Actor, id: string) {
    requirePerm(actor, 'kitchen.view');
    const t = this.ctx.db.get(`${this.baseQuery} WHERE t.id = ?`, id);
    if (!t) throw notFound('Pedido');
    return this.ticketView(t);
  }

  updateStatus(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'kitchen.update');
    const { status } = ticketStatusSchema.parse(raw);
    return this.ctx.tx(() => {
      const t = this.ticketRow(id);
      const from = t.status as TicketStatus;
      if (from === status) return this.ticket(actor, id);
      if (!canTransition(from, status)) {
        throw conflict(`Não é possível mudar de "${TICKET_STATUS[from]}" para "${TICKET_STATUS[status]}".`, 'INVALID_TRANSITION');
      }
      const now = this.ctx.nowIso();
      const col = TIMESTAMP_COL[status];
      const accepted = from === 'received' && status !== 'canceled' && !t.accepted_at ? ', accepted_at = ?' : '';
      const params: (string | null)[] = [status, actor.userId, now];
      if (accepted) params.push(now);
      this.ctx.db.run(
        `UPDATE order_tickets SET status = ?, updated_by = ?, updated_at = ?${accepted}${col ? `, ${col} = COALESCE(${col}, ?)` : ''},
         version = version + 1 WHERE id = ?`,
        ...params, ...(col ? [now] : []), id,
      );
      this.ctx.audit(actor, 'kitchen.status', 'order_ticket', id, { from, to: status });
      this.ctx.emit({ channel: 'kitchen', type: 'ticket.updated', data: { ticketId: id, status } });
      this.ctx.emit({ channel: 'tv', type: 'board.changed' });
      this.ctx.emit({ channel: 'comandas', type: 'order.status', data: { orderId: t.order_id, status } });
      return this.ticket(actor, id);
    });
  }

  /** "Aceitar" registra que a produção viu o pedido, sem mudar a coluna. */
  accept(actor: Actor, id: string) {
    requirePerm(actor, 'kitchen.update');
    return this.ctx.tx(() => {
      this.ticketRow(id);
      this.ctx.db.run('UPDATE order_tickets SET accepted_at = COALESCE(accepted_at, ?), updated_by = ?, version = version + 1, updated_at = ? WHERE id = ?', this.ctx.nowIso(), actor.userId, this.ctx.nowIso(), id);
      this.ctx.emit({ channel: 'kitchen', type: 'ticket.updated', data: { ticketId: id } });
      return this.ticket(actor, id);
    });
  }

  /**
   * Chama o cliente na TV: destaca o pedido, toca alerta e anuncia por voz.
   * Se o pedido ainda não estava pronto, ele é marcado como pronto.
   */
  call(actor: Actor, id: string) {
    requirePerm(actor, 'kitchen.call');
    return this.ctx.tx(() => {
      const t = this.ctx.db.get(`${this.baseQuery} WHERE t.id = ?`, id);
      if (!t) throw notFound('Pedido');
      if (t.status === 'canceled' || t.status === 'delivered') throw conflict('Este pedido já foi finalizado.', 'TICKET_FINISHED');
      const now = this.ctx.nowIso();
      if (t.status !== 'ready') {
        this.ctx.db.run("UPDATE order_tickets SET status = 'ready', ready_at = COALESCE(ready_at, ?), accepted_at = COALESCE(accepted_at, ?) WHERE id = ?", now, now, id);
      }
      this.ctx.db.run(
        'UPDATE order_tickets SET called_at = ?, call_count = call_count + 1, updated_by = ?, version = version + 1, updated_at = ? WHERE id = ?',
        now, actor.userId, now, id,
      );
      const name = firstName(t.customer_name as string);
      const text = pickupAnnouncement(Number(t.number), name || null, this.settings.operation().pickupPlace);
      const callId = this.ctx.id();
      this.ctx.db.run(
        'INSERT INTO pickup_calls (id, ticket_id, order_number, customer_first_name, text, called_by, created_at) VALUES (?,?,?,?,?,?,?)',
        callId, id, Number(t.number), name, text, actor.userId, now,
      );
      this.ctx.audit(actor, 'kitchen.call', 'order_ticket', id, { number: t.number, callCount: Number(t.call_count) + 1 });
      this.ctx.emit({
        channel: 'tv',
        type: 'pickup.call',
        data: { callId, ticketId: id, number: t.number, customerFirstName: name, text, voice: this.settings.operation().tvVoiceEnabled },
      });
      this.ctx.emit({ channel: 'kitchen', type: 'ticket.updated', data: { ticketId: id } });
      return { ...this.ticket(actor, id), callId, text };
    });
  }

  reprint(actor: Actor, id: string) {
    requirePerm(actor, 'kitchen.view');
    this.ticketRow(id);
    this.ctx.tx(() => {
      this.onReprint(id, actor);
      this.ctx.audit(actor, 'kitchen.reprint', 'order_ticket', id);
    });
    return { ok: true };
  }

  /**
   * Painel público da TV: somente número do pedido, primeiro nome e status.
   * Nunca inclui CPF, telefone, valores ou forma de pagamento.
   */
  tvBoard() {
    const day = businessDay(this.ctx.clock.now());
    const since = new Date(this.ctx.clock.now().getTime() - 4 * 3_600_000).toISOString();
    const rows = this.ctx.db.all<{
      order_id: string; number: number; customer_name: string; statuses: string; last_ready: string | null; last_call: string | null;
    }>(
      `SELECT o.id AS order_id, o.number, c.customer_name, GROUP_CONCAT(t.status) AS statuses,
              MAX(t.ready_at) AS last_ready, MAX(t.called_at) AS last_call
       FROM orders o JOIN comandas c ON c.id = o.comanda_id JOIN order_tickets t ON t.order_id = o.id
       WHERE o.business_day = ? AND o.created_at >= ?
       GROUP BY o.id ORDER BY o.number`,
      day, since,
    );
    const preparing: { number: number; name: string }[] = [];
    const ready: { number: number; name: string; readyAt: string | null; calledAt: string | null }[] = [];
    for (const r of rows) {
      const st = r.statuses.split(',').filter((s) => s !== 'canceled');
      if (st.length === 0 || st.every((s) => s === 'delivered')) continue;
      const name = firstName(r.customer_name);
      if (st.some((s) => s === 'received' || s === 'preparing')) preparing.push({ number: r.number, name });
      else if (st.some((s) => s === 'ready')) ready.push({ number: r.number, name, readyAt: r.last_ready, calledAt: r.last_call });
    }
    ready.sort((a, b) => String(b.calledAt ?? b.readyAt).localeCompare(String(a.calledAt ?? a.readyAt)));
    return { preparing, ready };
  }

  recentCalls(limit = 10) {
    return this.ctx.db.all('SELECT id, order_number, customer_first_name, text, created_at FROM pickup_calls ORDER BY created_at DESC LIMIT ?', limit);
  }
}
