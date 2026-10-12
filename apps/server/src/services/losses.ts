import { costOf, formatQty, LOSS_REASONS, type LossReason, type Measure } from '@rupbar/core';
import { lossResolveSchema, lossSchema } from '@rupbar/core/schemas';
import { z } from 'zod';
import type { Row } from '../db/db';
import { conflict, notFound } from '../lib/errors';
import { requirePerm, SYSTEM_ACTOR, type Actor, type Ctx } from './context';
import type { StockService } from './stock';

/** Payload do comando remoto "loss.register" enviado pelo painel online. */
export const remoteLossPayload = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().positive(),
  unit: z.enum(['un', 'ml', 'l', 'g', 'kg']),
  reason: z.enum(Object.keys(LOSS_REASONS) as [LossReason, ...LossReason[]]),
  occurredAt: z.string().datetime().optional(),
  notes: z.string().max(400).nullable().optional(),
  registeredByName: z.string().max(80).default('Proprietário (painel online)'),
});

export interface RemoteApplyResult {
  status: 'applied' | 'conflict' | 'rejected';
  message: string;
  lossId: string | null;
}

export class LossesService {
  constructor(
    private readonly ctx: Ctx,
    private readonly stock: StockService,
  ) {}

  private view(l: Row) {
    return {
      id: l.id, productId: l.product_id, productName: l.product_name, measure: l.measure, categoryName: l.category_name,
      qty: l.qty, appliedQty: l.applied_qty, unit: l.unit, reason: l.reason, reasonLabel: LOSS_REASONS[l.reason as LossReason],
      notes: l.notes, occurredAt: l.occurred_at, registeredByName: l.registered_by_name, source: l.source, status: l.status,
      costCents: l.cost_cents, attachmentId: l.attachment_id, appliedAt: l.applied_at, resolutionNote: l.resolution_note,
      remoteCommandId: l.remote_command_id, createdAt: l.created_at, currentStock: l.stock_qty,
    };
  }

  private query = `SELECT l.*, p.name AS product_name, p.measure, p.stock_qty, c.name AS category_name FROM losses l
    JOIN products p ON p.id = l.product_id JOIN categories c ON c.id = p.category_id`;

  get(id: string) {
    const l = this.ctx.db.get(`${this.query} WHERE l.id = ?`, id);
    if (!l) throw notFound('Perda');
    return this.view(l);
  }

  list(actor: Actor, filter: { status?: string; from?: string; to?: string; productId?: string } = {}) {
    requirePerm(actor, 'losses.view');
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) where.push('l.status = ?'), params.push(filter.status);
    if (filter.from) where.push('l.occurred_at >= ?'), params.push(filter.from);
    if (filter.to) where.push('l.occurred_at < ?'), params.push(filter.to);
    if (filter.productId) where.push('l.product_id = ?'), params.push(filter.productId);
    return this.ctx.db
      .all(`${this.query} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.occurred_at DESC LIMIT 500`, ...params)
      .map((l) => this.view(l));
  }

  private apply(lossId: string, productId: string, qty: number, userId: string | null, reasonLabel: string) {
    const r = this.stock.move({
      productId, type: 'loss', delta: -qty, refType: 'loss', refId: lossId, reason: reasonLabel, userId, allowNegative: false,
    });
    return r.costCents;
  }

  /** Perda registrada no PC pelo proprietário: aplicada imediatamente. */
  registerLocal(actor: Actor, raw: unknown) {
    requirePerm(actor, 'losses.confirm');
    const input = lossSchema.parse(raw);
    return this.ctx.tx(() => {
      if (input.clientRequestId) {
        const dup = this.ctx.db.value<string>('SELECT id FROM losses WHERE client_request_id = ?', input.clientRequestId);
        if (dup) return this.get(dup);
      }
      const p = this.ctx.db.get('SELECT * FROM products WHERE id = ?', input.productId);
      if (!p) throw notFound('Produto');
      if (p.stock_tracked !== 1) throw conflict('Este produto não tem controle de estoque.', 'NOT_TRACKED');
      if (input.qty > Number(p.stock_qty)) {
        throw conflict(
          `A perda (${formatQty(input.qty, p.measure as Measure)}) é maior que o saldo atual (${formatQty(Number(p.stock_qty), p.measure as Measure)}).`,
          'LOSS_EXCEEDS_STOCK',
        );
      }
      if (input.attachmentId && !this.ctx.db.get('SELECT id FROM attachments WHERE id = ?', input.attachmentId)) throw notFound('Comprovante');
      const id = this.ctx.id();
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO losses (id, product_id, qty, unit, reason, notes, occurred_at, registered_by, registered_by_name, source, status,
           client_request_id, attachment_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'local', 'pending_application', ?,?,?,?)`,
        id, input.productId, input.qty, input.unit, input.reason, input.notes, input.occurredAt ?? now, actor.userId, actor.name,
        input.clientRequestId ?? null, input.attachmentId, now, now,
      );
      const cost = this.apply(id, input.productId, input.qty, actor.userId, `Perda: ${LOSS_REASONS[input.reason]}`);
      this.ctx.db.run(
        "UPDATE losses SET status = 'applied', applied_qty = ?, cost_cents = ?, applied_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
        input.qty, cost, now, now, id,
      );
      this.ctx.audit(actor, 'losses.registered', 'loss', id, { product: p.name, qty: input.qty, reason: input.reason, costCents: cost });
      return this.get(id);
    });
  }

  /**
   * Aplica uma perda registrada no painel online. Executado pelo sincronizador,
   * no máximo uma vez por comando (remote_command_id é único).
   * Se o saldo atual não comporta a perda, NÃO reduz o estoque: registra
   * "Conflito de estoque" para o proprietário resolver no PC.
   */
  applyRemote(commandId: string, rawPayload: unknown): RemoteApplyResult {
    return this.ctx.tx(() => {
      const existing = this.ctx.db.get<{ id: string; status: string }>('SELECT id, status FROM losses WHERE remote_command_id = ?', commandId);
      if (existing) {
        return { status: existing.status === 'applied' ? 'applied' : existing.status === 'rejected' ? 'rejected' : 'conflict', message: 'Comando já processado.', lossId: existing.id };
      }
      const parsed = remoteLossPayload.safeParse(rawPayload);
      if (!parsed.success) return { status: 'rejected', message: 'Dados da perda inválidos.', lossId: null };
      const input = parsed.data;
      const p = this.ctx.db.get('SELECT * FROM products WHERE id = ?', input.productId);
      if (!p) return { status: 'rejected', message: 'Produto não existe no PC do bar.', lossId: null };
      if (p.stock_tracked !== 1) return { status: 'rejected', message: 'Produto sem controle de estoque.', lossId: null };
      const id = this.ctx.id();
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO losses (id, product_id, qty, unit, reason, notes, occurred_at, registered_by, registered_by_name, source, status,
           remote_command_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, NULL, ?, 'remote', 'pending_application', ?,?,?)`,
        id, input.productId, input.qty, input.unit, input.reason, input.notes ?? null, input.occurredAt ?? now, input.registeredByName,
        commandId, now, now,
      );
      if (input.qty > Number(p.stock_qty)) {
        const msg = `Saldo atual (${formatQty(Number(p.stock_qty), p.measure as Measure)}) menor que a perda (${formatQty(input.qty, p.measure as Measure)}). Resolva no PC do bar.`;
        this.ctx.db.run("UPDATE losses SET status = 'conflict', resolution_note = ?, cost_cents = ?, version = version + 1 WHERE id = ?", msg, costOf(input.qty, Number(p.unit_cost_e4)), id);
        this.ctx.audit({ ...SYSTEM_ACTOR, kind: 'remote', name: input.registeredByName }, 'losses.remote_conflict', 'loss', id, { commandId, qty: input.qty, stock: p.stock_qty });
        this.ctx.emit({ channel: 'stock', type: 'loss.conflict', data: { lossId: id } });
        return { status: 'conflict', message: msg, lossId: id };
      }
      const cost = this.apply(id, input.productId, input.qty, null, `Perda (painel online): ${LOSS_REASONS[input.reason]}`);
      this.ctx.db.run(
        "UPDATE losses SET status = 'applied', applied_qty = ?, cost_cents = ?, applied_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
        input.qty, cost, now, now, id,
      );
      this.ctx.audit({ ...SYSTEM_ACTOR, kind: 'remote', name: input.registeredByName }, 'losses.remote_applied', 'loss', id, { commandId, product: p.name, qty: input.qty });
      return { status: 'applied', message: 'Perda aplicada ao estoque.', lossId: id };
    });
  }

  /** Resolução segura de conflito (somente proprietário). */
  resolve(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'losses.confirm');
    const input = lossResolveSchema.parse(raw);
    return this.ctx.tx(() => {
      const l = this.ctx.db.get('SELECT l.*, p.stock_qty, p.name AS product_name FROM losses l JOIN products p ON p.id = l.product_id WHERE l.id = ?', id);
      if (!l) throw notFound('Perda');
      if (l.status !== 'conflict') throw conflict('Esta perda não está em conflito.', 'NOT_IN_CONFLICT');
      const now = this.ctx.nowIso();
      const stockNow = Number(l.stock_qty);
      if (input.action === 'reject') {
        this.ctx.db.run(
          "UPDATE losses SET status = 'rejected', resolution_note = ?, resolved_by = ?, version = version + 1, updated_at = ? WHERE id = ?",
          input.note, actor.userId, now, id,
        );
      } else {
        const qty = input.action === 'apply_full' ? Number(l.qty) : Math.min(Number(l.qty), Math.max(0, stockNow));
        if (qty <= 0) throw conflict('Não há saldo para aplicar a perda. Rejeite ou registre uma entrada antes.', 'NO_STOCK');
        if (input.action === 'apply_full' && qty > stockNow) {
          throw conflict('O saldo ainda é menor que a perda. Use "aplicar até o saldo disponível" ou rejeite.', 'LOSS_EXCEEDS_STOCK');
        }
        const cost = this.apply(id, String(l.product_id), qty, actor.userId, `Perda (conflito resolvido): ${LOSS_REASONS[l.reason as LossReason]}`);
        this.ctx.db.run(
          `UPDATE losses SET status = 'applied', applied_qty = ?, cost_cents = ?, applied_at = ?, resolution_note = ?, resolved_by = ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
          qty, cost, now, input.note, actor.userId, now, id,
        );
      }
      this.ctx.audit(actor, 'losses.conflict_resolved', 'loss', id, { action: input.action, note: input.note });
      return this.get(id);
    });
  }
}
