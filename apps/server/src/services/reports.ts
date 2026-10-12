import { LOSS_REASONS, type LossReason } from '@rupbar/core';
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import { businessDay } from '../lib/time';
import { hasPerm, requirePerm, type Actor, type Ctx } from './context';

export const periodSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

function period(raw: unknown) {
  const p = periodSchema.parse(raw);
  if (p.from >= p.to) throw badRequest('Período inválido.');
  return p;
}

/** Início do dia de operação atual (05:00 local) em ISO. */
function businessDayStart(now: Date, startHour = 5): Date {
  const day = businessDay(now, startHour);
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, startHour, 0, 0, 0);
}

export class ReportsService {
  constructor(private readonly ctx: Ctx) {}

  dashboard(actor: Actor) {
    const now = this.ctx.clock.now();
    const from = businessDayStart(now).toISOString();
    const db = this.ctx.db;
    const financial = hasPerm(actor, 'reports.financial');
    const base = {
      businessDay: businessDay(now),
      openComandas: Number(db.value("SELECT COUNT(*) FROM comandas WHERE status = 'open'")),
      ordersToday: Number(db.value('SELECT COUNT(*) FROM orders WHERE business_day = ?', businessDay(now))),
      inProduction: Number(db.value("SELECT COUNT(*) FROM order_tickets WHERE status IN ('received','preparing')")),
      readyForPickup: Number(db.value("SELECT COUNT(*) FROM order_tickets WHERE status = 'ready'")),
      stockAlerts: Number(db.value("SELECT COUNT(*) FROM stock_alerts WHERE status = 'open'")),
      lossConflicts: Number(db.value("SELECT COUNT(*) FROM losses WHERE status = 'conflict'")),
      hookahsInUse: Number(db.value("SELECT COUNT(*) FROM hookah_sessions WHERE status = 'active'")),
      cashOpen: !!db.value("SELECT id FROM cash_sessions WHERE status = 'open'"),
      failedPrints: Number(db.value("SELECT COUNT(*) FROM print_jobs WHERE status = 'failed'")),
    };
    if (!financial) return { ...base, financial: null };
    const sales = db.get<{ gross: number; items: number }>(
      "SELECT COALESCE(SUM(quantity * unit_price_cents),0) AS gross, COALESCE(SUM(quantity),0) AS items FROM comanda_items WHERE status = 'active' AND created_at >= ?",
      from,
    )!;
    const received = Number(db.value("SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE status = 'active' AND created_at >= ?", from));
    const closed = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM comandas WHERE status = 'closed' AND closed_at >= ?", from)!;
    const openValue = db.all<{ id: string }>("SELECT id FROM comandas WHERE status = 'open'");
    const openTotal = Number(
      db.value(
        "SELECT COALESCE(SUM(i.quantity * i.unit_price_cents),0) FROM comanda_items i JOIN comandas c ON c.id = i.comanda_id WHERE c.status = 'open' AND i.status = 'active'",
      ),
    );
    const byHour = db.all(
      `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, SUM(quantity * unit_price_cents) AS total
       FROM comanda_items WHERE status = 'active' AND created_at >= ? GROUP BY hour ORDER BY hour`,
      from,
    );
    return {
      ...base,
      financial: {
        salesCents: sales.gross,
        itemsSold: sales.items,
        receivedCents: received,
        closedComandas: closed.n,
        averageTicketCents: closed.n ? Math.round(received / closed.n) : 0,
        openComandasValueCents: openTotal,
        openComandasCount: openValue.length,
        byHour,
      },
    };
  }

  sales(actor: Actor, raw: unknown) {
    requirePerm(actor, 'reports.financial');
    const { from, to } = period(raw);
    const db = this.ctx.db;
    const totals = db.get<{ gross: number; cost: number; items: number }>(
      `SELECT COALESCE(SUM(quantity * unit_price_cents),0) AS gross, COALESCE(SUM(quantity * unit_cost_cents),0) AS cost, COALESCE(SUM(quantity),0) AS items
       FROM comanda_items WHERE status = 'active' AND created_at >= ? AND created_at < ?`,
      from, to,
    )!;
    const discounts = Number(db.value("SELECT COALESCE(SUM(discount_cents),0) FROM comandas WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?", from, to));
    const payments = db.all(
      "SELECT method, COUNT(*) AS count, SUM(amount_cents) AS total FROM payments WHERE status = 'active' AND created_at >= ? AND created_at < ? GROUP BY method ORDER BY total DESC",
      from, to,
    );
    const byDay = db.all(
      `SELECT date(created_at, 'localtime', '-5 hours') AS day, SUM(quantity * unit_price_cents) AS total, SUM(quantity * unit_cost_cents) AS cost
       FROM comanda_items WHERE status = 'active' AND created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`,
      from, to,
    );
    const byCategory = db.all(
      `SELECT COALESCE(c.name, 'Narguilé') AS category, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS total,
              SUM(i.quantity * i.unit_cost_cents) AS cost
       FROM comanda_items i LEFT JOIN categories c ON c.id = i.category_id
       WHERE i.status = 'active' AND i.created_at >= ? AND i.created_at < ? GROUP BY category ORDER BY total DESC`,
      from, to,
    );
    const topProducts = db.all(
      `SELECT i.product_id, i.product_name, i.presentation_name, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS total,
              SUM(i.quantity * i.unit_cost_cents) AS cost
       FROM comanda_items i WHERE i.status = 'active' AND i.kind = 'product' AND i.created_at >= ? AND i.created_at < ?
       GROUP BY i.presentation_id ORDER BY total DESC LIMIT 50`,
      from, to,
    );
    const cancellations = db.all(
      `SELECT i.product_name, i.presentation_name, i.quantity, i.unit_price_cents, i.cancel_reason, i.canceled_at, u.name AS canceled_by_name
       FROM comanda_items i LEFT JOIN users u ON u.id = i.canceled_by
       WHERE i.status = 'canceled' AND i.canceled_at >= ? AND i.canceled_at < ? ORDER BY i.canceled_at DESC LIMIT 200`,
      from, to,
    );
    const byWaiter = db.all(
      `SELECT u.name, COUNT(DISTINCT o.id) AS orders, SUM(i.quantity * i.unit_price_cents) AS total
       FROM comanda_items i JOIN orders o ON o.id = i.order_id JOIN users u ON u.id = o.created_by
       WHERE i.status = 'active' AND i.created_at >= ? AND i.created_at < ? GROUP BY u.id ORDER BY total DESC`,
      from, to,
    );
    return {
      grossCents: totals.gross, costCents: totals.cost, marginCents: totals.gross - totals.cost, itemsSold: totals.items,
      discountsCents: discounts, payments, byDay, byCategory, topProducts, cancellations, byWaiter,
    };
  }

  /** Comparação de produtos: quantidade, receita, custo e margem por dia. */
  compareProducts(actor: Actor, raw: unknown) {
    requirePerm(actor, 'reports.financial');
    const input = periodSchema.extend({ productIds: z.array(z.string().uuid()).min(1).max(8) }).parse(raw);
    const marks = input.productIds.map(() => '?').join(',');
    const rows = this.ctx.db.all(
      `SELECT i.product_id, i.product_name, date(i.created_at, 'localtime', '-5 hours') AS day, SUM(i.quantity) AS qty,
              SUM(i.quantity * i.unit_price_cents) AS total, SUM(i.quantity * i.unit_cost_cents) AS cost
       FROM comanda_items i WHERE i.status = 'active' AND i.product_id IN (${marks}) AND i.created_at >= ? AND i.created_at < ?
       GROUP BY i.product_id, day ORDER BY day`,
      ...input.productIds, input.from, input.to,
    );
    const summary = this.ctx.db.all(
      `SELECT p.id AS product_id, p.name, COALESCE(SUM(i.quantity),0) AS qty, COALESCE(SUM(i.quantity * i.unit_price_cents),0) AS total,
              COALESCE(SUM(i.quantity * i.unit_cost_cents),0) AS cost,
              (SELECT COALESCE(SUM(l.cost_cents),0) FROM losses l WHERE l.product_id = p.id AND l.status = 'applied' AND l.occurred_at >= ? AND l.occurred_at < ?) AS loss_cost
       FROM products p LEFT JOIN comanda_items i ON i.product_id = p.id AND i.status = 'active' AND i.created_at >= ? AND i.created_at < ?
       WHERE p.id IN (${marks}) GROUP BY p.id ORDER BY total DESC`,
      input.from, input.to, input.from, input.to, ...input.productIds,
    );
    return { summary, series: rows };
  }

  /** Relatório operacional (sem valores): itens vendidos, pedidos por hora e tempo de preparo. */
  operational(actor: Actor, raw: unknown) {
    requirePerm(actor, 'reports.operational');
    const { from, to } = period(raw);
    const items = this.ctx.db.all(
      `SELECT product_name, presentation_name, SUM(quantity) AS qty FROM comanda_items
       WHERE status = 'active' AND kind = 'product' AND created_at >= ? AND created_at < ? GROUP BY presentation_id ORDER BY qty DESC LIMIT 100`,
      from, to,
    );
    const ordersByHour = this.ctx.db.all(
      `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS orders FROM orders
       WHERE created_at >= ? AND created_at < ? GROUP BY hour ORDER BY hour`,
      from, to,
    );
    const prep = this.ctx.db.all(
      `SELECT station, COUNT(*) AS tickets, AVG((julianday(ready_at) - julianday(created_at)) * 1440) AS avg_minutes,
              MAX((julianday(ready_at) - julianday(created_at)) * 1440) AS max_minutes
       FROM order_tickets WHERE ready_at IS NOT NULL AND created_at >= ? AND created_at < ? GROUP BY station`,
      from, to,
    );
    return { items, ordersByHour, prep };
  }

  losses(actor: Actor, raw: unknown) {
    requirePerm(actor, 'losses.view');
    const { from, to } = period(raw);
    const showCost = hasPerm(actor, 'reports.financial');
    const where = "l.status = 'applied' AND l.occurred_at >= ? AND l.occurred_at < ?";
    const byProduct = this.ctx.db.all(
      `SELECT p.id AS product_id, p.name, p.measure, c.name AS category, COUNT(*) AS count, SUM(l.applied_qty) AS qty, SUM(l.cost_cents) AS cost_cents
       FROM losses l JOIN products p ON p.id = l.product_id JOIN categories c ON c.id = p.category_id WHERE ${where}
       GROUP BY p.id ORDER BY cost_cents DESC`,
      from, to,
    );
    const byCategory = this.ctx.db.all(
      `SELECT c.name AS category, COUNT(*) AS count, SUM(l.cost_cents) AS cost_cents FROM losses l JOIN products p ON p.id = l.product_id
       JOIN categories c ON c.id = p.category_id WHERE ${where} GROUP BY c.id ORDER BY cost_cents DESC`,
      from, to,
    );
    const byReason = this.ctx.db
      .all<{ reason: string; count: number; cost_cents: number }>(
        `SELECT l.reason, COUNT(*) AS count, SUM(l.cost_cents) AS cost_cents FROM losses l WHERE ${where} GROUP BY l.reason ORDER BY cost_cents DESC`,
        from, to,
      )
      .map((r) => ({ ...r, label: LOSS_REASONS[r.reason as LossReason] }));
    const total = byProduct.reduce((a, r) => a + Number(r.cost_cents), 0);
    const strip = <T extends Record<string, unknown>>(rows: T[]) => (showCost ? rows : rows.map((r) => ({ ...r, cost_cents: null })));
    return { totalCostCents: showCost ? total : null, byProduct: strip(byProduct), byCategory: strip(byCategory), byReason: strip(byReason) };
  }

  /** Estoque por categoria: quantidade de itens, abaixo do mínimo e valor de custo. */
  stockByCategory(actor: Actor) {
    requirePerm(actor, 'stock.view');
    const showCost = hasPerm(actor, 'reports.financial');
    return this.ctx.db
      .all(
        `SELECT c.name AS category, COUNT(p.id) AS products,
                SUM(CASE WHEN p.min_stock > 0 AND p.stock_qty <= p.min_stock THEN 1 ELSE 0 END) AS below_min,
                SUM(CASE WHEN p.stock_qty > 0 THEN p.stock_qty * p.unit_cost_e4 / 10000000.0 ELSE 0 END) AS value_cents
         FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND p.stock_tracked = 1 GROUP BY c.id ORDER BY c.sort_order`,
      )
      .map((r) => ({ ...r, value_cents: showCost ? Math.round(Number(r.value_cents)) : null }));
  }

  audit(actor: Actor, filter: { entity?: string; entityId?: string; action?: string; limit?: number } = {}) {
    requirePerm(actor, 'audit.view');
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.entity) where.push('entity = ?'), params.push(filter.entity);
    if (filter.entityId) where.push('entity_id = ?'), params.push(filter.entityId);
    if (filter.action) where.push('action LIKE ?'), params.push(`${filter.action}%`);
    params.push(Math.min(filter.limit ?? 200, 1000));
    return this.ctx.db.all(
      `SELECT id, user_name, action, entity, entity_id, data_json, ip, created_at FROM audit_log
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`,
      ...params,
    );
  }
}
