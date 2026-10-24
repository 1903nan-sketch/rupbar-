import { comandaLabel, isValidDay, LOSS_REASONS, reportWindow, type FullReport, type LossReason } from '@rupbar/core';
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
      "SELECT COALESCE(SUM(quantity * unit_price_cents),0) AS gross, COALESCE(SUM(quantity),0) AS items FROM comanda_items WHERE status = 'active' AND staff = 0 AND created_at >= ?",
      from,
    )!;
    const received = Number(db.value("SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE status = 'active' AND created_at >= ?", from));
    const closed = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM comandas WHERE status = 'closed' AND closed_at >= ?", from)!;
    const openValue = db.all<{ id: string }>("SELECT id FROM comandas WHERE status = 'open'");
    const openTotal = Number(
      db.value(
        "SELECT COALESCE(SUM(i.quantity * i.unit_price_cents),0) FROM comanda_items i JOIN comandas c ON c.id = i.comanda_id WHERE c.status = 'open' AND i.status = 'active' AND i.staff = 0",
      ),
    );
    const byHour = db.all(
      `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, SUM(quantity * unit_price_cents) AS total
       FROM comanda_items WHERE status = 'active' AND staff = 0 AND created_at >= ? GROUP BY hour ORDER BY hour`,
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
       FROM comanda_items WHERE status = 'active' AND staff = 0 AND created_at >= ? AND created_at < ?`,
      from, to,
    )!;
    const discounts = Number(db.value("SELECT COALESCE(SUM(discount_cents),0) FROM comandas WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?", from, to));
    const payments = db.all(
      "SELECT method, COUNT(*) AS count, SUM(amount_cents) AS total FROM payments WHERE status = 'active' AND created_at >= ? AND created_at < ? GROUP BY method ORDER BY total DESC",
      from, to,
    );
    const byDay = db.all(
      `SELECT date(created_at, 'localtime', '-5 hours') AS day, SUM(quantity * unit_price_cents) AS total, SUM(quantity * unit_cost_cents) AS cost
       FROM comanda_items WHERE status = 'active' AND staff = 0 AND created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`,
      from, to,
    );
    const byCategory = db.all(
      `SELECT COALESCE(c.name, 'Narguilé') AS category, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS total,
              SUM(i.quantity * i.unit_cost_cents) AS cost
       FROM comanda_items i LEFT JOIN categories c ON c.id = i.category_id
       WHERE i.status = 'active' AND i.staff = 0 AND i.created_at >= ? AND i.created_at < ? GROUP BY category ORDER BY total DESC`,
      from, to,
    );
    const topProducts = db.all(
      `SELECT i.product_id, i.product_name, i.presentation_name, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS total,
              SUM(i.quantity * i.unit_cost_cents) AS cost
       FROM comanda_items i WHERE i.status = 'active' AND i.staff = 0 AND i.kind = 'product' AND i.created_at >= ? AND i.created_at < ?
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
       WHERE i.status = 'active' AND i.staff = 0 AND i.created_at >= ? AND i.created_at < ? GROUP BY u.id ORDER BY total DESC`,
      from, to,
    );
    // Consumo de funcionário: fora das vendas; aqui só para o dono acompanhar (valor de cardápio e custo).
    const staffConsumption = db.all(
      `SELECT COALESCE(u.name, c.customer_name, 'Funcionário') AS name, COUNT(DISTINCT c.id) AS comandas, SUM(i.quantity) AS items,
              SUM(i.quantity * i.unit_price_cents) AS value, SUM(i.quantity * i.unit_cost_cents) AS cost
       FROM comanda_items i JOIN comandas c ON c.id = i.comanda_id LEFT JOIN users u ON u.id = c.staff_user_id
       WHERE i.status = 'active' AND i.staff = 1 AND i.created_at >= ? AND i.created_at < ?
       GROUP BY COALESCE(c.staff_user_id, c.customer_name) ORDER BY value DESC`,
      from, to,
    );
    return {
      grossCents: totals.gross, costCents: totals.cost, marginCents: totals.gross - totals.cost, itemsSold: totals.items,
      discountsCents: discounts, payments, byDay, byCategory, topProducts, cancellations, byWaiter, staffConsumption,
    };
  }

  /**
   * Relatório completo de um dia do bar (05:00 às 05:00) ou de vários dias:
   * o mesmo formato do painel online, para tela, PDF e impressora do caixa.
   */
  full(actor: Actor, raw: unknown): FullReport {
    requirePerm(actor, 'reports.financial');
    const q = z.object({ de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(raw);
    if (!isValidDay(q.de) || (q.ate !== undefined && !isValidDay(q.ate))) throw badRequest('Data inválida.');
    const { de, ate, from, to } = reportWindow(q.de, q.ate ?? q.de);
    const db = this.ctx.db;
    // Horário de Brasília fixo (igual ao painel online), não o fuso do computador.
    const n = (v: unknown) => Number(v ?? 0);
    const W = 'created_at >= ? AND created_at < ?';
    const items = db.get<{ gross: number; cost: number; items: number }>(
      `SELECT COALESCE(SUM(quantity * unit_price_cents),0) AS gross, COALESCE(SUM(quantity * unit_cost_cents),0) AS cost, COALESCE(SUM(quantity),0) AS items
       FROM comanda_items WHERE status = 'active' AND staff = 0 AND ${W}`, from, to,
    )!;
    // Comandas encerradas no período: desconto (nunca maior que os itens) e taxa de serviço.
    const closed = db.all<{ kind: string; discount: number; bp: number; subtotal: number }>(
      `SELECT c.kind, c.discount_cents AS discount, c.service_fee_bp AS bp,
              (SELECT COALESCE(SUM(i.quantity * i.unit_price_cents),0) FROM comanda_items i WHERE i.comanda_id = c.id AND i.status = 'active') AS subtotal
       FROM comandas c WHERE c.status = 'closed' AND c.kind <> 'staff' AND c.closed_at >= ? AND c.closed_at < ?`, from, to,
    );
    let discounts = 0;
    let fee = 0;
    for (const c of closed) {
      const d = Math.min(n(c.discount), n(c.subtotal));
      discounts += d;
      fee += Math.round(((n(c.subtotal) - d) * n(c.bp)) / 10_000);
    }
    const stillOpen = db.get<{ count: number; value: number }>(
      `SELECT COUNT(DISTINCT c.id) AS count, COALESCE(SUM(CASE WHEN i.status = 'active' THEN i.quantity * i.unit_price_cents ELSE 0 END),0) AS value
       FROM comandas c LEFT JOIN comanda_items i ON i.comanda_id = c.id WHERE c.status = 'open' AND c.kind = 'regular' AND c.opened_at >= ? AND c.opened_at < ?`, from, to,
    )!;
    const byHourRaw = db.all<{ hour: number; total: number }>(
      `SELECT CAST(strftime('%H', created_at, '-3 hours') AS INTEGER) AS hour, SUM(quantity * unit_price_cents) AS total
       FROM comanda_items WHERE status = 'active' AND staff = 0 AND ${W} GROUP BY hour`, from, to,
    );
    const cashSessions = db.all(
      `SELECT s.*, uo.name AS opened_name, uc.name AS closed_name,
              (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p WHERE p.cash_session_id = s.id AND p.status = 'active' AND p.method = 'cash') AS cash_in,
              (SELECT COALESCE(SUM(CASE WHEN m.type = 'supply' THEN m.amount_cents ELSE -m.amount_cents END),0) FROM cash_movements m
                WHERE m.session_id = s.id AND m.status = 'active') AS moves
       FROM cash_sessions s LEFT JOIN users uo ON uo.id = s.opened_by LEFT JOIN users uc ON uc.id = s.closed_by
       WHERE s.opened_at >= ? AND s.opened_at < ? ORDER BY s.opened_at`, from, to,
    );
    const lossesRows = db.all<{ product: string; reason: string; count: number; cost: number }>(
      `SELECT p.name AS product, l.reason, COUNT(*) AS count, COALESCE(SUM(l.cost_cents),0) AS cost FROM losses l JOIN products p ON p.id = l.product_id
       WHERE l.status = 'applied' AND l.occurred_at >= ? AND l.occurred_at < ? GROUP BY p.id, l.reason ORDER BY cost DESC, product`, from, to,
    );
    const hookah = db.get<{ sessions: number; total: number }>(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(charge_cents),0) AS total FROM hookah_sessions WHERE status <> 'canceled' AND started_at >= ? AND started_at < ?`, from, to,
    )!;
    const payments = db.all<{ method: string; count: number; total: number }>(
      `SELECT method, COUNT(*) AS count, SUM(amount_cents) AS total FROM payments WHERE status = 'active' AND ${W} GROUP BY method ORDER BY total DESC, method`, from, to,
    );
    const count = (sql: string) => n(db.value(sql, from, to));
    return {
      barName: String(db.value('SELECT trade_name FROM establishment LIMIT 1') ?? 'RupBar'),
      from, to, de, ate, generatedAt: this.ctx.nowIso(),
      summary: {
        grossCents: n(items.gross), discountsCents: discounts, serviceFeeCents: fee,
        receivedCents: payments.reduce((a, p) => a + n(p.total), 0), costCents: n(items.cost), itemsSold: n(items.items),
        closedComandas: closed.filter((c) => c.kind === 'regular').length,
        quickSales: closed.filter((c) => c.kind === 'quick').length,
        canceledComandas: count("SELECT COUNT(*) FROM comandas WHERE status = 'canceled' AND canceled_at >= ? AND canceled_at < ?"),
        canceledCents: count("SELECT COALESCE(SUM(quantity * unit_price_cents),0) FROM comanda_items WHERE status = 'canceled' AND staff = 0 AND canceled_at >= ? AND canceled_at < ?"),
        reversedCents: count("SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE status <> 'active' AND reversed_at >= ? AND reversed_at < ?"),
        staffCents: count(`SELECT COALESCE(SUM(quantity * unit_price_cents),0) FROM comanda_items WHERE status = 'active' AND staff = 1 AND ${W}`),
        lossesCents: lossesRows.reduce((a, l) => a + n(l.cost), 0),
        stillOpen: n(stillOpen.count), stillOpenCents: n(stillOpen.value),
      },
      payments: payments.map((p) => ({ method: p.method, count: n(p.count), totalCents: n(p.total) })),
      // A noite em ordem: 05h … 23h, 00h … 04h.
      byHour: byHourRaw.map((h) => ({ hour: n(h.hour), totalCents: n(h.total) })).sort((a, b) => ((a.hour + 19) % 24) - ((b.hour + 19) % 24)),
      byDay: db.all<{ day: string; total: number; cost: number }>(
        `SELECT date(created_at, '-8 hours') AS day, SUM(quantity * unit_price_cents) AS total, SUM(quantity * unit_cost_cents) AS cost
         FROM comanda_items WHERE status = 'active' AND staff = 0 AND ${W} GROUP BY day ORDER BY day`, from, to,
      ).map((d) => ({ day: d.day, totalCents: n(d.total), costCents: n(d.cost) })),
      byCategory: db.all<{ category: string; qty: number; total: number; cost: number }>(
        `SELECT COALESCE(c.name, 'Narguilé') AS category, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS total, SUM(i.quantity * i.unit_cost_cents) AS cost
         FROM comanda_items i LEFT JOIN categories c ON c.id = i.category_id
         WHERE i.status = 'active' AND i.staff = 0 AND i.created_at >= ? AND i.created_at < ? GROUP BY category ORDER BY total DESC, category`, from, to,
      ).map((c) => ({ category: c.category, qty: n(c.qty), totalCents: n(c.total), costCents: n(c.cost) })),
      products: db.all<{ name: string; presentation: string; qty: number; total: number; cost: number }>(
        `SELECT product_name AS name, presentation_name AS presentation, SUM(quantity) AS qty, SUM(quantity * unit_price_cents) AS total, SUM(quantity * unit_cost_cents) AS cost
         FROM comanda_items WHERE status = 'active' AND staff = 0 AND ${W}
         GROUP BY product_name, presentation_name ORDER BY total DESC, qty DESC, name`, from, to,
      ).map((p) => ({ name: p.name, presentation: p.presentation ?? '', qty: n(p.qty), totalCents: n(p.total), costCents: n(p.cost) })),
      byWaiter: db.all<{ name: string; orders: number; total: number }>(
        `SELECT COALESCE(u.name, 'Sem nome') AS name, COUNT(DISTINCT i.order_id) AS orders, SUM(i.quantity * i.unit_price_cents) AS total
         FROM comanda_items i LEFT JOIN users u ON u.id = i.created_by
         WHERE i.status = 'active' AND i.staff = 0 AND i.created_at >= ? AND i.created_at < ? GROUP BY i.created_by ORDER BY total DESC, name`, from, to,
      ).map((w) => ({ name: w.name, orders: n(w.orders), totalCents: n(w.total) })),
      discounts: db.all(
        `SELECT c.number, c.card_number, c.kind, c.customer_name, c.discount_reason, c.discount_cents, c.closed_at, u.name AS closed_name,
                (SELECT COALESCE(SUM(i.quantity * i.unit_price_cents),0) FROM comanda_items i WHERE i.comanda_id = c.id AND i.status = 'active') AS subtotal
         FROM comandas c LEFT JOIN users u ON u.id = c.closed_by
         WHERE c.status = 'closed' AND c.kind <> 'staff' AND c.discount_cents > 0 AND c.closed_at >= ? AND c.closed_at < ? ORDER BY c.closed_at`, from, to,
      ).map((c) => ({
        comanda: comandaLabel({ number: n(c.number), cardNumber: c.card_number === null ? null : n(c.card_number), kind: String(c.kind) }),
        customer: (c.customer_name as string | null) || null, reason: (c.discount_reason as string | null) ?? null,
        discountCents: Math.min(n(c.discount_cents), n(c.subtotal)), closedAt: (c.closed_at as string | null) ?? null, closedBy: (c.closed_name as string | null) ?? null,
      })),
      cancellations: db.all(
        `SELECT i.product_name, i.presentation_name, i.quantity, i.unit_price_cents, i.cancel_reason, i.canceled_at, u.name AS canceled_name
         FROM comanda_items i LEFT JOIN users u ON u.id = i.canceled_by
         WHERE i.status = 'canceled' AND i.canceled_at >= ? AND i.canceled_at < ? ORDER BY i.canceled_at`, from, to,
      ).map((c) => ({
        at: String(c.canceled_at), product: String(c.product_name), qty: n(c.quantity), totalCents: n(c.quantity) * n(c.unit_price_cents),
        reason: (c.cancel_reason as string | null) ?? null, by: (c.canceled_name as string | null) ?? null,
      })),
      staffConsumption: db.all<{ name: string; items: number; value: number; cost: number }>(
        `SELECT COALESCE(u.name, c.customer_name, 'Funcionário') AS name, SUM(i.quantity) AS items, SUM(i.quantity * i.unit_price_cents) AS value,
                SUM(i.quantity * i.unit_cost_cents) AS cost
         FROM comanda_items i JOIN comandas c ON c.id = i.comanda_id LEFT JOIN users u ON u.id = c.staff_user_id
         WHERE i.status = 'active' AND i.staff = 1 AND i.created_at >= ? AND i.created_at < ?
         GROUP BY COALESCE(c.staff_user_id, c.customer_name) ORDER BY value DESC, name`, from, to,
      ).map((x) => ({ name: x.name, items: n(x.items), valueCents: n(x.value), costCents: n(x.cost) })),
      cashSessions: cashSessions.map((c) => {
        const open = c.status === 'open';
        return {
          number: n(c.number), status: String(c.status), openedAt: String(c.opened_at), openedBy: (c.opened_name as string | null) ?? null,
          closedAt: (c.closed_at as string | null) ?? null, closedBy: (c.closed_name as string | null) ?? null, openingCents: n(c.opening_balance_cents),
          // Caixa ainda aberto: o esperado é calculado agora, como no fechamento.
          expectedCents: open ? n(c.opening_balance_cents) + n(c.cash_in) + n(c.moves) : c.expected_cash_cents === null ? null : n(c.expected_cash_cents),
          countedCents: c.counted_cash_cents === null ? null : n(c.counted_cash_cents),
          differenceCents: c.difference_cents === null ? null : n(c.difference_cents),
        };
      }),
      cashMovements: db.all(
        `SELECT m.created_at, m.type, m.amount_cents, m.reason, u.name AS by_name FROM cash_movements m LEFT JOIN users u ON u.id = m.created_by
         WHERE m.status = 'active' AND m.created_at >= ? AND m.created_at < ? ORDER BY m.created_at`, from, to,
      ).map((m) => ({ at: String(m.created_at), type: m.type === 'supply' ? 'supply' as const : 'withdrawal' as const, amountCents: n(m.amount_cents), reason: String(m.reason), by: (m.by_name as string | null) ?? null })),
      losses: lossesRows.map((l) => ({ product: l.product, reason: LOSS_REASONS[l.reason as LossReason] ?? l.reason, count: n(l.count), costCents: n(l.cost) })),
      hookah: { sessions: n(hookah.sessions), totalCents: n(hookah.total) },
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
       FROM comanda_items i WHERE i.status = 'active' AND i.staff = 0 AND i.product_id IN (${marks}) AND i.created_at >= ? AND i.created_at < ?
       GROUP BY i.product_id, day ORDER BY day`,
      ...input.productIds, input.from, input.to,
    );
    const summary = this.ctx.db.all(
      `SELECT p.id AS product_id, p.name, COALESCE(SUM(i.quantity),0) AS qty, COALESCE(SUM(i.quantity * i.unit_price_cents),0) AS total,
              COALESCE(SUM(i.quantity * i.unit_cost_cents),0) AS cost,
              (SELECT COALESCE(SUM(l.cost_cents),0) FROM losses l WHERE l.product_id = p.id AND l.status = 'applied' AND l.occurred_at >= ? AND l.occurred_at < ?) AS loss_cost
       FROM products p LEFT JOIN comanda_items i ON i.product_id = p.id AND i.status = 'active' AND i.staff = 0 AND i.created_at >= ? AND i.created_at < ?
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
       WHERE status = 'active' AND staff = 0 AND kind = 'product' AND created_at >= ? AND created_at < ? GROUP BY presentation_id ORDER BY qty DESC LIMIT 100`,
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
