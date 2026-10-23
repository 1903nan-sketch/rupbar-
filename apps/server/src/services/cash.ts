import { cashClosing, changeFor, PAYMENT_METHODS, type PaymentMethod } from '@rupbar/core';
import { cashCloseSchema, cashMovementSchema, cashOpenSchema, paymentSchema, reversePaymentSchema } from '@rupbar/core/schemas';
import { json, type Row } from '../db/db';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { ComandasService } from './comandas';
import { hasPerm, requirePerm, type Actor, type Ctx } from './context';
import type { SettingsService } from './settings';

export class CashService {
  onSessionClosed: (sessionId: string) => void = () => {};

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    private readonly comandas: ComandasService,
  ) {}

  openSession(): Row | undefined {
    return this.ctx.db.get("SELECT * FROM cash_sessions WHERE status = 'open'");
  }

  private sessionRow(id: string): Row {
    const s = this.ctx.db.get('SELECT * FROM cash_sessions WHERE id = ?', id);
    if (!s) throw notFound('Caixa');
    return s;
  }

  summary(sessionId: string, countedCash: number | null = null) {
    const s = this.sessionRow(sessionId);
    const payments = this.ctx.db.all<{ method: PaymentMethod; amount: number }>(
      "SELECT method, amount_cents AS amount FROM payments WHERE cash_session_id = ? AND status = 'active'",
      sessionId,
    );
    const moves = this.ctx.db.all<{ type: string; amount_cents: number }>(
      "SELECT type, amount_cents FROM cash_movements WHERE session_id = ? AND status = 'active'",
      sessionId,
    );
    return cashClosing({
      openingBalance: Number(s.opening_balance_cents),
      payments,
      withdrawals: moves.filter((m) => m.type === 'withdrawal').map((m) => m.amount_cents),
      supplies: moves.filter((m) => m.type === 'supply').map((m) => m.amount_cents),
      countedCash,
    });
  }

  /** Estado do caixa atual. Valores esperados só aparecem para quem pode fechar o caixa. */
  current(actor: Actor) {
    requirePerm(actor, 'cash.view');
    const s = this.openSession();
    if (!s) return { open: false as const, defaultOpeningBalanceCents: this.settings.operation().defaultOpeningBalanceCents };
    const canSeeTotals = hasPerm(actor, 'cash.close') || hasPerm(actor, 'reports.financial');
    return {
      open: true as const,
      session: this.sessionView(s),
      summary: canSeeTotals ? this.summary(String(s.id)) : null,
      movements: this.movements(String(s.id)),
    };
  }

  private sessionView(s: Row) {
    const name = (id: unknown) => (id ? (this.ctx.db.value<string>('SELECT name FROM users WHERE id = ?', String(id)) ?? null) : null);
    return {
      id: s.id, number: s.number, status: s.status, openedAt: s.opened_at, openedBy: s.opened_by, openedByName: name(s.opened_by),
      openingBalanceCents: s.opening_balance_cents, openingNotes: s.opening_notes, closedAt: s.closed_at, closedBy: s.closed_by,
      closedByName: name(s.closed_by), countedCashCents: s.counted_cash_cents, expectedCashCents: s.expected_cash_cents,
      differenceCents: s.difference_cents, closingNotes: s.closing_notes, summary: json(s.summary_json, null),
    };
  }

  movements(sessionId: string) {
    return this.ctx.db.all(
      `SELECT m.id, m.type, m.amount_cents, m.reason, m.attachment_id, m.created_at, m.status, m.void_reason, m.voided_at, u.name AS created_by_name
       FROM cash_movements m LEFT JOIN users u ON u.id = m.created_by WHERE m.session_id = ? ORDER BY m.created_at`,
      sessionId,
    );
  }

  open(actor: Actor, raw: unknown) {
    requirePerm(actor, 'cash.open');
    const input = cashOpenSchema.parse(raw);
    return this.ctx.tx(() => {
      if (this.openSession()) throw conflict('Já existe um caixa aberto.', 'CASH_ALREADY_OPEN');
      const id = this.ctx.id();
      const number = this.ctx.nextSeq('cash_session');
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO cash_sessions (id, number, status, opened_by, opened_at, opening_balance_cents, opening_notes, updated_at)
         VALUES (?,?, 'open', ?,?,?,?,?)`,
        id, number, actor.userId, now, input.openingBalanceCents, input.notes, now,
      );
      this.ctx.audit(actor, 'cash.opened', 'cash_session', id, { number, openingBalanceCents: input.openingBalanceCents });
      this.ctx.emit({ channel: 'cash', type: 'cash.opened', data: { sessionId: id } });
      return this.sessionView(this.sessionRow(id));
    });
  }

  movement(actor: Actor, raw: unknown) {
    const input = cashMovementSchema.parse(raw);
    requirePerm(actor, input.type === 'withdrawal' ? 'cash.withdrawal' : 'cash.supply');
    return this.ctx.tx(() => {
      const dup = this.ctx.db.get('SELECT id FROM cash_movements WHERE client_request_id = ?', input.clientRequestId);
      if (dup) return { id: String(dup.id), duplicate: true };
      const s = this.openSession();
      if (!s) throw conflict('Abra o caixa antes de registrar movimentações.', 'CASH_CLOSED');
      if (input.attachmentId && !this.ctx.db.get('SELECT id FROM attachments WHERE id = ?', input.attachmentId)) throw notFound('Comprovante');
      if (input.type === 'withdrawal') {
        const sum = this.summary(String(s.id));
        if (input.amountCents > sum.expectedCash) {
          throw conflict('O valor da sangria é maior que o dinheiro esperado no caixa.', 'WITHDRAWAL_EXCEEDS_CASH', { expectedCash: sum.expectedCash });
        }
      }
      const id = this.ctx.id();
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO cash_movements (id, session_id, type, amount_cents, reason, attachment_id, client_request_id, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, String(s.id), input.type, input.amountCents, input.reason, input.attachmentId, input.clientRequestId, actor.userId, now, now,
      );
      this.ctx.audit(actor, input.type === 'withdrawal' ? 'cash.withdrawal' : 'cash.supply', 'cash_movement', id, {
        amountCents: input.amountCents, reason: input.reason, attachment: !!input.attachmentId,
      });
      this.ctx.emit({ channel: 'cash', type: 'cash.movement', data: { sessionId: s.id } });
      return { id, duplicate: false };
    });
  }

  close(actor: Actor, raw: unknown) {
    requirePerm(actor, 'cash.close');
    const input = cashCloseSchema.parse(raw);
    return this.ctx.tx(() => {
      const s = this.openSession();
      if (!s) throw conflict('Não há caixa aberto.', 'CASH_CLOSED');
      const sum = this.summary(String(s.id), input.countedCashCents);
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `UPDATE cash_sessions SET status = 'closed', closed_by = ?, closed_at = ?, counted_cash_cents = ?, expected_cash_cents = ?,
           difference_cents = ?, summary_json = ?, closing_notes = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        actor.userId, now, input.countedCashCents, sum.expectedCash, sum.difference, JSON.stringify(sum), input.notes, now, String(s.id),
      );
      this.ctx.audit(actor, 'cash.closed', 'cash_session', String(s.id), {
        number: s.number, expected: sum.expectedCash, counted: input.countedCashCents, difference: sum.difference,
      });
      this.ctx.emit({ channel: 'cash', type: 'cash.closed', data: { sessionId: s.id } });
      this.onSessionClosed(String(s.id));
      return this.sessionView(this.sessionRow(String(s.id)));
    });
  }

  sessions(actor: Actor, limit = 60) {
    requirePerm(actor, 'reports.financial');
    return this.ctx.db.all('SELECT * FROM cash_sessions ORDER BY number DESC LIMIT ?', limit).map((s) => this.sessionView(s));
  }

  sessionDetail(actor: Actor, id: string) {
    requirePerm(actor, 'reports.financial');
    const s = this.sessionRow(id);
    return {
      session: this.sessionView(s),
      summary: s.status === 'closed' ? json(s.summary_json, null) : this.summary(id),
      movements: this.movements(id),
      payments: this.ctx.db.all(
        `SELECT p.*, c.number AS comanda_number, u.name AS created_by_name FROM payments p JOIN comandas c ON c.id = p.comanda_id
         LEFT JOIN users u ON u.id = p.created_by WHERE p.cash_session_id = ? ORDER BY p.created_at`,
        id,
      ),
    };
  }

  // -------------------------------------------------------------- pagamentos

  pay(actor: Actor, raw: unknown) {
    requirePerm(actor, 'cash.payment');
    const input = paymentSchema.parse(raw);
    return this.ctx.tx(() => {
      const dup = this.ctx.db.get('SELECT id FROM payments WHERE client_request_id = ?', input.clientRequestId);
      if (dup) return { id: String(dup.id), duplicate: true, comanda: this.comandas.detail(actor, input.comandaId) };
      const c = this.ctx.db.get('SELECT * FROM comandas WHERE id = ?', input.comandaId);
      if (!c) throw notFound('Comanda');
      if (c.status !== 'open') throw conflict('Esta comanda já foi encerrada.', 'COMANDA_NOT_OPEN');
      if (c.kind === 'staff') throw conflict('Consumo de funcionário não é cobrado: é só encerrar a comanda.', 'STAFF_NO_PAYMENT');
      const session = this.openSession();
      if (!session && (input.method === 'cash' || this.settings.operation().requireCashSessionForPayments)) {
        throw conflict('Abra o caixa antes de receber pagamentos.', 'CASH_CLOSED');
      }
      const t = this.comandas.totals(input.comandaId);
      if (input.amountCents > t.remaining) {
        throw conflict('O valor é maior que o saldo da comanda.', 'OVERPAYMENT', { remaining: t.remaining });
      }
      let change = 0;
      if (input.method === 'cash' && input.receivedCents !== undefined) {
        if (input.receivedCents < input.amountCents) throw badRequest('Valor recebido menor que o valor do pagamento.');
        change = changeFor(input.amountCents, input.receivedCents);
      }
      const id = this.ctx.id();
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO payments (id, comanda_id, cash_session_id, method, amount_cents, received_cents, change_cents, payer_label,
           client_request_id, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
        id, input.comandaId, session ? String(session.id) : null, input.method, input.amountCents, input.receivedCents ?? null, change,
        input.payerLabel, input.clientRequestId, actor.userId, now, now,
      );
      this.comandas.touch(input.comandaId, 'payment');
      this.ctx.audit(actor, 'cash.payment', 'payment', id, {
        comanda: c.number, method: PAYMENT_METHODS[input.method], amountCents: input.amountCents, change,
      });
      this.ctx.emit({ channel: 'cash', type: 'payment.created', data: { comandaId: input.comandaId } });
      return { id, duplicate: false, changeCents: change, comanda: this.comandas.detail(actor, input.comandaId) };
    });
  }

  reversePayment(actor: Actor, paymentId: string, raw: unknown) {
    requirePerm(actor, 'cash.payment_reverse');
    const input = reversePaymentSchema.parse(raw);
    return this.ctx.tx(() => {
      const p = this.ctx.db.get('SELECT p.*, c.status AS comanda_status, c.number FROM payments p JOIN comandas c ON c.id = p.comanda_id WHERE p.id = ?', paymentId);
      if (!p) throw notFound('Pagamento');
      if (p.status !== 'active') throw conflict('Pagamento já estornado.', 'ALREADY_REVERSED');
      if (p.comanda_status !== 'open') throw conflict('Só é possível estornar pagamentos de comandas abertas.', 'COMANDA_NOT_OPEN');
      if (p.cash_session_id) {
        const s = this.sessionRow(String(p.cash_session_id));
        if (s.status !== 'open') throw conflict('O caixa deste pagamento já foi fechado.', 'CASH_SESSION_CLOSED');
      }
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        "UPDATE payments SET status = 'reversed', reversed_by = ?, reversed_at = ?, reverse_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        actor.userId, now, input.reason, now, paymentId,
      );
      this.comandas.touch(String(p.comanda_id), 'payment_reversed');
      this.ctx.audit(actor, 'cash.payment_reversed', 'payment', paymentId, { comanda: p.number, amountCents: p.amount_cents, reason: input.reason });
      return this.comandas.detail(actor, String(p.comanda_id));
    });
  }
}
