import { PAYMENT_METHODS } from '@rupbar/core';
import {
  overrideCashMovementSchema, overrideCashSessionSchema, overrideDeleteSchema, overrideItemSchema, overridePaymentSchema, overrideReasonSchema,
} from '@rupbar/core/schemas';
import type { Row } from '../db/db';
import { conflict, notFound } from '../lib/errors';
import type { CashService } from './cash';
import type { ComandasService } from './comandas';
import { requirePerm, type Actor, type Ctx } from './context';
import type { StockService } from './stock';

/**
 * Correções da conta mestre (somente o proprietário, permissão admin.override).
 *
 * O proprietário pode editar e excluir qualquer lançamento, inclusive de
 * comandas e caixas já encerrados. Para manter estoque, caixa, relatórios e
 * nuvem coerentes, nada é apagado do banco:
 *  - "excluir" anula o registro com motivo (estorno, cancelamento);
 *  - "editar" anula o original e lança o valor corrigido;
 *  - caixas fechados têm o resumo recalculado;
 *  - tudo fica no histórico de correções (auditoria "admin.*").
 */
export class AdminService {
  constructor(
    private readonly ctx: Ctx,
    private readonly comandas: ComandasService,
    private readonly cash: CashService,
    private readonly stock: StockService,
  ) {}

  private get db() {
    return this.ctx.db;
  }

  private get(table: string, id: string, what: string): Row {
    const r = this.db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!r) throw notFound(what);
    return r;
  }

  /** Recalcula o resumo de um caixa já fechado depois de uma correção. */
  private recomputeSession(sessionId: unknown) {
    if (!sessionId) return;
    const s = this.db.get('SELECT * FROM cash_sessions WHERE id = ?', String(sessionId));
    if (!s || s.status !== 'closed') return;
    const counted = s.counted_cash_cents === null ? null : Number(s.counted_cash_cents);
    const sum = this.cash.summary(String(sessionId), counted);
    this.db.run(
      'UPDATE cash_sessions SET expected_cash_cents = ?, difference_cents = ?, summary_json = ?, version = version + 1, updated_at = ? WHERE id = ?',
      sum.expectedCash, sum.difference, JSON.stringify(sum), this.ctx.nowIso(), String(sessionId),
    );
    this.ctx.emit({ channel: 'cash', type: 'cash.corrected', data: { sessionId } });
  }

  /** Reabre uma comanda encerrada (libera o cartão se ele já estiver em outra comanda). */
  private reopen(c: Row, why: string) {
    let card = c.card_number;
    if (card !== null && this.db.get("SELECT id FROM comandas WHERE status = 'open' AND card_number = ? AND id <> ?", card, String(c.id))) card = null;
    this.db.run("UPDATE comandas SET status = 'open', closed_at = NULL, closed_by = NULL, card_number = ? WHERE id = ?", card, String(c.id));
    this.comandas.touch(String(c.id), why);
  }

  /** Comanda encerrada que voltou a ter saldo é reaberta para ser cobrada. */
  private settle(comandaId: string) {
    const c = this.get('comandas', comandaId, 'Comanda');
    if (c.status === 'closed' && this.comandas.totals(comandaId).remaining > 0) this.reopen(c, 'reopened_balance');
    else this.comandas.touch(comandaId, 'corrected');
  }

  private changed(channelData: { comandaId?: string }) {
    this.ctx.emit({ channel: 'kitchen', type: 'order.changed', data: channelData });
    this.ctx.emit({ channel: 'tv', type: 'board.changed' });
  }

  // ------------------------------------------------------------- comandas

  reopenComanda(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const c = this.get('comandas', id, 'Comanda');
      if (c.status !== 'closed') throw conflict('Só comandas encerradas podem ser reabertas.', 'NOT_CLOSED');
      this.reopen(c, 'reopened');
      this.ctx.audit(actor, 'admin.comanda_reopened', 'comanda', id, { number: c.number, reason });
      return this.comandas.detail(actor, id);
    });
  }

  /** Exclui a comanda: estorna pagamentos, cancela itens (devolvendo o estoque) e pedidos. */
  deleteComanda(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const input = overrideDeleteSchema.parse(raw);
    return this.ctx.tx(() => {
      const c = this.get('comandas', id, 'Comanda');
      if (c.status === 'canceled') throw conflict('Esta comanda já foi excluída.', 'ALREADY_CANCELED');
      const now = this.ctx.nowIso();
      const reason = `Excluída pelo proprietário: ${input.reason}`;
      const sessions = new Set<string>();
      for (const p of this.db.all("SELECT id, cash_session_id FROM payments WHERE comanda_id = ? AND status = 'active'", id)) {
        this.db.run(
          "UPDATE payments SET status = 'reversed', reversed_by = ?, reversed_at = ?, reverse_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
          actor.userId, now, reason, now, String(p.id),
        );
        if (p.cash_session_id) sessions.add(String(p.cash_session_id));
      }
      for (const i of this.db.all("SELECT id, kind FROM comanda_items WHERE comanda_id = ? AND status = 'active'", id)) {
        this.db.run(
          "UPDATE comanda_items SET status = 'canceled', cancel_reason = ?, canceled_by = ?, canceled_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
          reason, actor.userId, now, now, String(i.id),
        );
        if (input.returnToStock && i.kind === 'product') this.stock.reverseSale(String(i.id), actor.userId, reason);
      }
      this.db.run(
        `UPDATE order_tickets SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
         WHERE order_id IN (SELECT id FROM orders WHERE comanda_id = ?) AND status <> 'canceled'`,
        now, now, id,
      );
      for (const s of this.db.all("SELECT s.id, s.hookah_id, h.owner FROM hookah_sessions s JOIN hookahs h ON h.id = s.hookah_id WHERE s.comanda_id = ? AND s.status = 'active'", id)) {
        this.db.run("UPDATE hookah_sessions SET status = 'canceled', ended_at = ?, version = version + 1, updated_at = ? WHERE id = ?", now, now, String(s.id));
        this.db.run('UPDATE hookahs SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', s.owner === 'house' ? 'available' : 'inactive', now, String(s.hookah_id));
      }
      this.db.run(
        "UPDATE comandas SET status = 'canceled', canceled_by = ?, canceled_at = ?, cancel_reason = ? WHERE id = ?",
        actor.userId, now, reason, id,
      );
      for (const s of sessions) this.recomputeSession(s);
      this.comandas.touch(id, 'deleted');
      this.changed({ comandaId: id });
      this.ctx.audit(actor, 'admin.comanda_deleted', 'comanda', id, { number: c.number, previousStatus: c.status, reason: input.reason });
      return this.comandas.detail(actor, id);
    });
  }

  // ---------------------------------------------------------------- itens

  /** Corrige quantidade e/ou preço de um item, mesmo em comanda encerrada. */
  editItem(actor: Actor, itemId: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const input = overrideItemSchema.parse(raw);
    return this.ctx.tx(() => {
      const item = this.get('comanda_items', itemId, 'Item');
      if (item.status !== 'active') throw conflict('Este item já foi excluído.', 'ALREADY_CANCELED');
      const comandaId = String(item.comanda_id);
      const now = this.ctx.nowIso();
      const sameQty = Number(item.quantity) === input.quantity;
      if (sameQty || item.kind !== 'product' || !item.presentation_id) {
        this.db.run(
          'UPDATE comanda_items SET quantity = ?, unit_price_cents = ?, version = version + 1, updated_at = ? WHERE id = ?',
          input.quantity, input.unitPriceCents, now, itemId,
        );
      } else {
        // Quantidade diferente: cancela o original (devolve o estoque) e lança o corrigido.
        const reason = `Corrigido pelo proprietário: ${input.reason}`;
        this.db.run(
          "UPDATE comanda_items SET status = 'canceled', cancel_reason = ?, canceled_by = ?, canceled_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
          reason, actor.userId, now, now, itemId,
        );
        this.stock.reverseSale(itemId, actor.userId, reason);
        const newId = this.ctx.id();
        this.db.run(
          `INSERT INTO comanda_items (id, comanda_id, order_id, kind, presentation_id, product_id, product_name, presentation_name, category_id,
             quantity, unit_price_cents, notes, station, created_by, created_at, updated_at)
           VALUES (?,?,?,'product',?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId, comandaId, item.order_id, item.presentation_id, item.product_id, item.product_name, item.presentation_name, item.category_id,
          input.quantity, input.unitPriceCents, item.notes, item.station, item.created_by, String(item.created_at), now,
        );
        const cost = this.stock.deductForSale(newId, String(item.presentation_id), input.quantity, actor.userId);
        this.db.run('UPDATE comanda_items SET unit_cost_cents = ? WHERE id = ?', Math.round(cost / input.quantity), newId);
      }
      this.settle(comandaId);
      this.changed({ comandaId });
      this.ctx.audit(actor, 'admin.item_edited', 'comanda_item', itemId, {
        product: item.product_name, from: { quantity: item.quantity, unitPriceCents: item.unit_price_cents },
        to: { quantity: input.quantity, unitPriceCents: input.unitPriceCents }, reason: input.reason,
      });
      return this.comandas.detail(actor, comandaId);
    });
  }

  deleteItem(actor: Actor, itemId: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const input = overrideDeleteSchema.parse(raw);
    return this.ctx.tx(() => {
      const item = this.get('comanda_items', itemId, 'Item');
      if (item.status !== 'active') throw conflict('Este item já foi excluído.', 'ALREADY_CANCELED');
      const now = this.ctx.nowIso();
      const reason = `Excluído pelo proprietário: ${input.reason}`;
      this.db.run(
        "UPDATE comanda_items SET status = 'canceled', cancel_reason = ?, canceled_by = ?, canceled_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
        reason, actor.userId, now, now, itemId,
      );
      if (input.returnToStock && item.kind === 'product') this.stock.reverseSale(itemId, actor.userId, reason);
      if (item.order_id) {
        const remaining = Number(this.db.value("SELECT COUNT(*) FROM comanda_items WHERE order_id = ? AND station = ? AND status = 'active'", String(item.order_id), String(item.station)));
        if (remaining === 0) {
          this.db.run(
            "UPDATE order_tickets SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ? WHERE order_id = ? AND station = ? AND status <> 'canceled'",
            now, now, String(item.order_id), String(item.station),
          );
        }
      }
      this.settle(String(item.comanda_id));
      this.changed({ comandaId: String(item.comanda_id) });
      this.ctx.audit(actor, 'admin.item_deleted', 'comanda_item', itemId, {
        product: item.product_name, quantity: item.quantity, totalCents: Number(item.quantity) * Number(item.unit_price_cents), reason: input.reason,
      });
      return this.comandas.detail(actor, String(item.comanda_id));
    });
  }

  // ----------------------------------------------------------- pagamentos

  /** Troca forma e/ou valor de um pagamento: estorna o original e lança o corrigido no mesmo caixa. */
  editPayment(actor: Actor, paymentId: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const input = overridePaymentSchema.parse(raw);
    return this.ctx.tx(() => {
      const p = this.get('payments', paymentId, 'Pagamento');
      if (p.status !== 'active') throw conflict('Este pagamento já foi excluído.', 'ALREADY_REVERSED');
      const comandaId = String(p.comanda_id);
      const t = this.comandas.totals(comandaId);
      if (t.paid - Number(p.amount_cents) + input.amountCents > t.total) {
        throw conflict('Com esse valor, o pago ficaria maior que o total da comanda.', 'OVERPAYMENT', { total: t.total });
      }
      const now = this.ctx.nowIso();
      this.db.run(
        "UPDATE payments SET status = 'reversed', reversed_by = ?, reversed_at = ?, reverse_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        actor.userId, now, `Corrigido pelo proprietário: ${input.reason}`, now, paymentId,
      );
      const newId = this.ctx.id();
      this.db.run(
        `INSERT INTO payments (id, comanda_id, cash_session_id, method, amount_cents, received_cents, change_cents, payer_label,
           client_request_id, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,NULL,0,?,?, 'active', ?,?,?)`,
        newId, comandaId, p.cash_session_id, input.method, input.amountCents, p.payer_label, this.ctx.id(), actor.userId, String(p.created_at), now,
      );
      this.recomputeSession(p.cash_session_id);
      this.settle(comandaId);
      this.ctx.emit({ channel: 'cash', type: 'payment.corrected', data: { comandaId } });
      this.ctx.audit(actor, 'admin.payment_edited', 'payment', paymentId, {
        from: { method: PAYMENT_METHODS[p.method as keyof typeof PAYMENT_METHODS], amountCents: p.amount_cents },
        to: { method: PAYMENT_METHODS[input.method], amountCents: input.amountCents }, newPaymentId: newId, reason: input.reason,
      });
      return this.comandas.detail(actor, comandaId);
    });
  }

  deletePayment(actor: Actor, paymentId: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const p = this.get('payments', paymentId, 'Pagamento');
      if (p.status !== 'active') throw conflict('Este pagamento já foi excluído.', 'ALREADY_REVERSED');
      const now = this.ctx.nowIso();
      this.db.run(
        "UPDATE payments SET status = 'reversed', reversed_by = ?, reversed_at = ?, reverse_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        actor.userId, now, `Excluído pelo proprietário: ${reason}`, now, paymentId,
      );
      this.recomputeSession(p.cash_session_id);
      this.settle(String(p.comanda_id));
      this.ctx.emit({ channel: 'cash', type: 'payment.corrected', data: { comandaId: p.comanda_id } });
      this.ctx.audit(actor, 'admin.payment_deleted', 'payment', paymentId, { method: p.method, amountCents: p.amount_cents, reason });
      return this.comandas.detail(actor, String(p.comanda_id));
    });
  }

  // ---------------------------------------------------------------- caixa

  editCashMovement(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const input = overrideCashMovementSchema.parse(raw);
    return this.ctx.tx(() => {
      const m = this.get('cash_movements', id, 'Movimentação');
      if (m.status !== 'active') throw conflict('Esta movimentação já foi excluída.', 'ALREADY_VOIDED');
      const now = this.ctx.nowIso();
      this.db.run(
        "UPDATE cash_movements SET status = 'voided', voided_by = ?, voided_at = ?, void_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        actor.userId, now, `Corrigida pelo proprietário: ${input.reason}`, now, id,
      );
      const newId = this.ctx.id();
      this.db.run(
        `INSERT INTO cash_movements (id, session_id, type, amount_cents, reason, attachment_id, client_request_id, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        newId, String(m.session_id), String(m.type), input.amountCents, input.description, m.attachment_id, this.ctx.id(), String(m.created_by), String(m.created_at), now,
      );
      this.recomputeSession(m.session_id);
      this.ctx.emit({ channel: 'cash', type: 'cash.movement', data: { sessionId: m.session_id } });
      this.ctx.audit(actor, 'admin.cash_movement_edited', 'cash_movement', id, {
        from: { amountCents: m.amount_cents, description: m.reason }, to: { amountCents: input.amountCents, description: input.description }, reason: input.reason,
      });
      return { id: newId };
    });
  }

  deleteCashMovement(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const m = this.get('cash_movements', id, 'Movimentação');
      if (m.status !== 'active') throw conflict('Esta movimentação já foi excluída.', 'ALREADY_VOIDED');
      const now = this.ctx.nowIso();
      this.db.run(
        "UPDATE cash_movements SET status = 'voided', voided_by = ?, voided_at = ?, void_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        actor.userId, now, `Excluída pelo proprietário: ${reason}`, now, id,
      );
      this.recomputeSession(m.session_id);
      this.ctx.emit({ channel: 'cash', type: 'cash.movement', data: { sessionId: m.session_id } });
      this.ctx.audit(actor, 'admin.cash_movement_deleted', 'cash_movement', id, { type: m.type, amountCents: m.amount_cents, reason });
      return { ok: true };
    });
  }

  /** Corrige troco inicial e/ou dinheiro contado de um caixa (aberto ou fechado). */
  editCashSession(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const input = overrideCashSessionSchema.parse(raw);
    return this.ctx.tx(() => {
      const s = this.get('cash_sessions', id, 'Caixa');
      const now = this.ctx.nowIso();
      if (input.openingBalanceCents !== undefined) this.db.run('UPDATE cash_sessions SET opening_balance_cents = ?, updated_at = ? WHERE id = ?', input.openingBalanceCents, now, id);
      if (input.countedCashCents !== undefined && s.status === 'closed') this.db.run('UPDATE cash_sessions SET counted_cash_cents = ?, updated_at = ? WHERE id = ?', input.countedCashCents, now, id);
      this.recomputeSession(id);
      this.ctx.emit({ channel: 'cash', type: 'cash.corrected', data: { sessionId: id } });
      this.ctx.audit(actor, 'admin.cash_session_edited', 'cash_session', id, {
        number: s.number, from: { opening: s.opening_balance_cents, counted: s.counted_cash_cents },
        to: { opening: input.openingBalanceCents, counted: input.countedCashCents }, reason: input.reason,
      });
      return { ok: true };
    });
  }

  reopenCashSession(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const s = this.get('cash_sessions', id, 'Caixa');
      if (s.status !== 'closed') throw conflict('Este caixa já está aberto.', 'CASH_ALREADY_OPEN');
      if (this.db.get("SELECT id FROM cash_sessions WHERE status = 'open'")) throw conflict('Feche o caixa atual antes de reabrir outro.', 'CASH_ALREADY_OPEN');
      this.db.run(
        `UPDATE cash_sessions SET status = 'open', closed_at = NULL, closed_by = NULL, counted_cash_cents = NULL, expected_cash_cents = NULL,
           difference_cents = NULL, summary_json = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
        this.ctx.nowIso(), id,
      );
      this.ctx.emit({ channel: 'cash', type: 'cash.opened', data: { sessionId: id } });
      this.ctx.audit(actor, 'admin.cash_session_reopened', 'cash_session', id, { number: s.number, reason });
      return { ok: true };
    });
  }

  // --------------------------------------------------------------- estoque

  /** Exclui uma entrada de mercadoria: retira do estoque o que ela tinha somado. */
  cancelPurchase(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const pu = this.get('purchases', id, 'Entrada');
      if (pu.status === 'canceled') throw conflict('Esta entrada já foi excluída.', 'ALREADY_CANCELED');
      const label = `Entrada excluída pelo proprietário: ${reason}`;
      for (const i of this.db.all('SELECT id, product_id, qty FROM purchase_items WHERE purchase_id = ?', id)) {
        this.stock.move({
          productId: String(i.product_id), type: 'purchase_cancel', delta: -Number(i.qty), refType: 'purchase_item', refId: String(i.id),
          reason: label, userId: actor.userId, allowNegative: true,
        });
        this.db.run('UPDATE stock_lots SET qty_remaining = 0, updated_at = ? WHERE purchase_item_id = ?', this.ctx.nowIso(), String(i.id));
      }
      const now = this.ctx.nowIso();
      this.db.run(
        "UPDATE purchases SET status = 'canceled', canceled_by = ?, canceled_at = ?, cancel_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        actor.userId, now, reason, now, id,
      );
      this.ctx.audit(actor, 'admin.purchase_canceled', 'purchase', id, { totalCents: pu.total_cents, invoice: pu.invoice_number, reason });
      return { ok: true };
    });
  }

  /** Desfaz um ajuste/inventário/consumo lançando a movimentação inversa. */
  reverseStockMovement(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const m = this.get('stock_movements', id, 'Movimentação de estoque');
      if (!['adjustment', 'inventory', 'hookah', 'purchase', 'sale', 'loss'].includes(String(m.type))) {
        throw conflict('Esta movimentação já é uma correção e não pode ser desfeita.', 'NOT_REVERSIBLE');
      }
      if (m.type === 'sale') throw conflict('Para vendas, exclua ou edite o item na comanda.', 'USE_ITEM');
      if (m.type === 'purchase') throw conflict('Para entradas, exclua a entrada inteira em Estoque → Entradas.', 'USE_PURCHASE');
      if (m.type === 'loss') throw conflict('Para perdas, exclua a perda em Perdas.', 'USE_LOSS');
      if (this.db.get("SELECT id FROM stock_movements WHERE ref_type = 'movement' AND ref_id = ?", id)) throw conflict('Esta movimentação já foi desfeita.', 'ALREADY_REVERSED');
      this.stock.move({
        productId: String(m.product_id), type: 'correction', delta: -Number(m.delta), refType: 'movement', refId: id,
        reason: `Desfeito pelo proprietário: ${reason}`, userId: actor.userId, allowNegative: true,
      });
      this.ctx.audit(actor, 'admin.stock_movement_reversed', 'stock_movement', id, { type: m.type, delta: m.delta, reason });
      return { ok: true };
    });
  }

  /** Exclui uma perda: devolve ao estoque o que ela tinha baixado. */
  deleteLoss(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const l = this.get('losses', id, 'Perda');
      if (l.status === 'rejected') throw conflict('Esta perda já foi excluída.', 'ALREADY_CANCELED');
      for (const m of this.db.all("SELECT product_id, delta FROM stock_movements WHERE ref_type = 'loss' AND ref_id = ? AND type = 'loss'", id)) {
        this.stock.move({
          productId: String(m.product_id), type: 'loss_reversal', delta: -Number(m.delta), refType: 'loss', refId: id,
          reason: `Perda excluída pelo proprietário: ${reason}`, userId: actor.userId,
        });
      }
      const now = this.ctx.nowIso();
      this.db.run(
        "UPDATE losses SET status = 'rejected', resolution_note = ?, resolved_by = ?, version = version + 1, updated_at = ? WHERE id = ?",
        `Excluída pelo proprietário: ${reason}`, actor.userId, now, id,
      );
      this.ctx.emit({ channel: 'stock', type: 'loss.changed', data: { lossId: id } });
      this.ctx.audit(actor, 'admin.loss_deleted', 'loss', id, { qty: l.qty, previousStatus: l.status, reason });
      return { ok: true };
    });
  }

  // -------------------------------------------------------------- narguilé

  deleteHookahSession(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const { reason } = overrideReasonSchema.parse(raw);
    return this.ctx.tx(() => {
      const s = this.get('hookah_sessions', id, 'Locação');
      if (s.status === 'canceled') throw conflict('Esta locação já foi excluída.', 'ALREADY_CANCELED');
      const now = this.ctx.nowIso();
      const label = `Excluído pelo proprietário: ${reason}`;
      this.db.run(
        `UPDATE comanda_items SET status = 'canceled', cancel_reason = ?, canceled_by = ?, canceled_at = ?, version = version + 1, updated_at = ?
         WHERE (hookah_session_id = ? OR id = ?) AND status = 'active'`,
        label, actor.userId, now, now, id, s.comanda_item_id,
      );
      if (s.status === 'active') {
        const h = this.get('hookahs', String(s.hookah_id), 'Narguilé');
        this.db.run('UPDATE hookahs SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', h.owner === 'house' ? 'available' : 'inactive', now, String(h.id));
        this.ctx.emit({ channel: 'hookah', type: 'hookah.status', data: { hookahId: h.id } });
      }
      this.db.run("UPDATE hookah_sessions SET status = 'canceled', ended_at = COALESCE(ended_at, ?), charge_cents = 0, version = version + 1, updated_at = ? WHERE id = ?", now, now, id);
      this.settle(String(s.comanda_id));
      this.ctx.audit(actor, 'admin.hookah_session_deleted', 'hookah_session', id, { reason });
      return { ok: true };
    });
  }

  // -------------------------------------------------------------- histórico

  history(actor: Actor, limit = 200) {
    if (!actor.permissions.has('admin.override')) requirePerm(actor, 'audit.view');
    return this.db
      .all("SELECT id, user_name, action, entity, entity_id, data_json, created_at FROM audit_log WHERE action LIKE 'admin.%' ORDER BY created_at DESC LIMIT ?", Math.min(limit, 1000))
      .map((r) => ({ ...r, data: r.data_json ? JSON.parse(String(r.data_json)) : null, data_json: undefined }));
  }
}
