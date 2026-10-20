import {
  consumptionFor, costOf, divergence, entryQtyMilli, formatQty, restockSuggestion, stockLevel, unitCostFromPurchase, weightedAverageCost,
  type Measure, type StockMovementType,
} from '@rupbar/core';
import { adjustmentSchema, inventorySchema, purchaseSchema } from '@rupbar/core/schemas';
import { bool, type Row } from '../db/db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { localDate } from '../lib/time';
import { requirePerm, type Actor, type Ctx } from './context';
import type { SettingsService } from './settings';

export interface MoveInput {
  productId: string;
  type: StockMovementType;
  /** Variação em milli (negativa para saídas). */
  delta: number;
  refType: string | null;
  refId: string | null;
  reason?: string | null;
  userId: string | null;
  /** Custo unitário a registrar (entradas); saídas usam o custo médio atual. */
  unitCostE4?: number;
  /** Se false, impede saldo negativo mesmo com a configuração permitindo. */
  allowNegative?: boolean;
}

export interface MoveResult {
  movementId: string;
  balanceAfter: number;
  costCents: number;
}

export class StockService {
  onAlertOpened: (alertId: string, productId: string) => void = () => {};

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
  ) {}

  private productRow(id: string): Row {
    const p = this.ctx.db.get('SELECT * FROM products WHERE id = ?', id);
    if (!p) throw notFound('Produto');
    return p;
  }

  /**
   * Registra uma movimentação e atualiza o saldo em uma única transação.
   * O índice único (ref_type, ref_id, product_id, type) impede baixa duplicada:
   * repetir a mesma operação lança erro em vez de descontar duas vezes.
   */
  move(input: MoveInput): MoveResult {
    if (!this.ctx.db.inTransaction) return this.ctx.tx(() => this.move(input));
    const p = this.productRow(input.productId);
    if (input.refId) {
      const dup = this.ctx.db.get(
        'SELECT id, balance_after, cost_cents FROM stock_movements WHERE ref_type = ? AND ref_id = ? AND product_id = ? AND type = ?',
        input.refType, input.refId, input.productId, input.type,
      );
      if (dup) return { movementId: String(dup.id), balanceAfter: Number(dup.balance_after), costCents: Number(dup.cost_cents) };
    }
    const current = Number(p.stock_qty);
    const balance = current + input.delta;
    const allowNegative = input.allowNegative ?? this.settings.operation().allowNegativeStock;
    if (input.delta < 0 && balance < 0 && !allowNegative) {
      throw conflict(
        `Estoque insuficiente de ${p.name}: disponível ${formatQty(Math.max(0, current), p.measure as Measure)}, necessário ${formatQty(-input.delta, p.measure as Measure)}.`,
        'OUT_OF_STOCK',
        { productId: p.id, productName: p.name, available: current, required: -input.delta },
      );
    }
    let unitCost = Number(p.unit_cost_e4);
    if (input.delta > 0 && input.unitCostE4 !== undefined) {
      unitCost = weightedAverageCost(current, unitCost, input.delta, input.unitCostE4);
    }
    const costCents = costOf(Math.abs(input.delta), input.delta > 0 && input.unitCostE4 !== undefined ? input.unitCostE4 : Number(p.unit_cost_e4));
    const id = this.ctx.id();
    const now = this.ctx.nowIso();
    this.ctx.db.run(
      `INSERT INTO stock_movements (id, product_id, type, delta, balance_after, unit_cost_e4, cost_cents, ref_type, ref_id, reason, user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.productId, input.type, input.delta, balance, input.unitCostE4 ?? Number(p.unit_cost_e4), costCents,
      input.refType, input.refId, input.reason ?? null, input.userId, now,
    );
    this.ctx.db.run(
      'UPDATE products SET stock_qty = ?, unit_cost_e4 = ?, version = version + 1, updated_at = ? WHERE id = ?',
      balance, unitCost, now, input.productId,
    );
    if (input.delta < 0 && bool(p.expiry_tracked)) this.consumeLots(input.productId, -input.delta);
    this.evaluateAlert(input.productId);
    this.ctx.emit({ channel: 'stock', type: 'stock.changed', data: { productId: input.productId, balance } });
    return { movementId: id, balanceAfter: balance, costCents };
  }

  /** Lotes com validade: consome primeiro o que vence antes (FIFO por vencimento). */
  private consumeLots(productId: string, qty: number) {
    let remaining = qty;
    const lots = this.ctx.db.all<{ id: string; qty_remaining: number }>(
      'SELECT id, qty_remaining FROM stock_lots WHERE product_id = ? AND qty_remaining > 0 ORDER BY expires_on, created_at',
      productId,
    );
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.qty_remaining, remaining);
      this.ctx.db.run('UPDATE stock_lots SET qty_remaining = qty_remaining - ?, updated_at = ? WHERE id = ?', take, this.ctx.nowIso(), lot.id);
      remaining -= take;
    }
  }

  /** Abre/resolve alerta de estoque mínimo. Um único alerta aberto por produto. */
  evaluateAlert(productId: string): void {
    const p = this.ctx.db.get<{ stock_qty: number; min_stock: number; stock_tracked: number; active: number }>(
      'SELECT stock_qty, min_stock, stock_tracked, active FROM products WHERE id = ?',
      productId,
    );
    if (!p) return;
    const open = this.ctx.db.get<{ id: string }>("SELECT id FROM stock_alerts WHERE product_id = ? AND status = 'open'", productId);
    const low = p.stock_tracked === 1 && p.active === 1 && p.min_stock > 0 && stockLevel(p.stock_qty, p.min_stock) !== 'ok';
    const now = this.ctx.nowIso();
    if (low && !open) {
      const id = this.ctx.id();
      this.ctx.db.run(
        'INSERT INTO stock_alerts (id, product_id, stock_qty, min_stock, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        id, productId, p.stock_qty, p.min_stock, 'open', now, now,
      );
      this.ctx.emit({ channel: 'stock', type: 'alert.opened', data: { productId, alertId: id } });
      this.onAlertOpened(id, productId);
    } else if (low && open) {
      this.ctx.db.run('UPDATE stock_alerts SET stock_qty = ?, min_stock = ?, version = version + 1, updated_at = ? WHERE id = ?', p.stock_qty, p.min_stock, now, open.id);
    } else if (!low && open) {
      this.ctx.db.run(
        "UPDATE stock_alerts SET status = 'resolved', stock_qty = ?, resolved_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
        p.stock_qty, now, now, open.id,
      );
      this.ctx.emit({ channel: 'stock', type: 'alert.resolved', data: { productId } });
    }
  }

  /** Componentes (ficha técnica) de uma apresentação. */
  components(presentationId: string): { productId: string; qty: number }[] {
    return this.ctx.db
      .all<{ ingredient_product_id: string; qty: number }>(
        'SELECT ingredient_product_id, qty FROM presentation_components WHERE presentation_id = ?',
        presentationId,
      )
      .map((c) => ({ productId: c.ingredient_product_id, qty: c.qty }));
  }

  /**
   * Baixa de estoque de um item vendido (uma vez por item, garantido pelo índice
   * único). Retorna o custo total estimado.
   */
  deductForSale(itemId: string, presentationId: string, quantity: number, userId: string | null, extra: { productId: string; qty: number }[] = [], skipBase = false): number {
    let cost = 0;
    // A ficha técnica e as escolhas do pedido (ex.: a lata de Red Bull) numa baixa só.
    // No meio a meio na hora, só as metades (skipBase): a porção base não sai inteira.
    for (const [productId, qty] of consumptionFor([...(skipBase ? [] : this.components(presentationId)), ...extra], quantity)) {
      const p = this.ctx.db.get<{ stock_tracked: number; unit_cost_e4: number }>('SELECT stock_tracked, unit_cost_e4 FROM products WHERE id = ?', productId);
      if (!p) continue;
      if (p.stock_tracked !== 1) {
        cost += costOf(qty, p.unit_cost_e4);
        continue;
      }
      cost += this.move({ productId, type: 'sale', delta: -qty, refType: 'comanda_item', refId: itemId, userId }).costCents;
    }
    return cost;
  }

  /** O que as escolhas gravadas num item baixam do estoque (por unidade). */
  static optionComponents(optionsJson: unknown): { productId: string; qty: number }[] {
    if (typeof optionsJson !== 'string' || !optionsJson) return [];
    try {
      const list = JSON.parse(optionsJson) as { productId?: string | null; qty?: number }[];
      return list.filter((o) => o.productId && Number(o.qty) > 0).map((o) => ({ productId: String(o.productId), qty: Number(o.qty) }));
    } catch {
      return [];
    }
  }

  /** Meio a meio na hora: as metades substituem a ficha da porção base. */
  static replacesBase(optionsJson: unknown): boolean {
    if (typeof optionsJson !== 'string' || !optionsJson) return false;
    try {
      return (JSON.parse(optionsJson) as { free?: boolean }[]).some((o) => o.free === true);
    } catch {
      return false;
    }
  }

  /** Estorna a baixa de um item cancelado (devolve ao estoque). */
  reverseSale(itemId: string, userId: string | null, reason: string): void {
    const moves = this.ctx.db.all<{ product_id: string; delta: number }>(
      "SELECT product_id, delta FROM stock_movements WHERE ref_type = 'comanda_item' AND ref_id = ? AND type = 'sale'",
      itemId,
    );
    for (const m of moves) {
      this.move({ productId: m.product_id, type: 'sale_reversal', delta: -m.delta, refType: 'comanda_item', refId: itemId, reason, userId });
    }
  }

  // ------------------------------------------------------------ entradas

  purchase(actor: Actor, raw: unknown) {
    requirePerm(actor, 'stock.entry');
    const input = purchaseSchema.parse(raw);
    const id = this.ctx.id();
    return this.ctx.tx(() => {
      const now = this.ctx.nowIso();
      if (input.supplierId && !this.ctx.db.get('SELECT id FROM suppliers WHERE id = ?', input.supplierId)) throw notFound('Fornecedor');
      const total = input.items.reduce((a, i) => a + i.totalCostCents, 0);
      this.ctx.db.run(
        `INSERT INTO purchases (id, supplier_id, invoice_number, purchased_at, notes, total_cents, attachment_id, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, input.supplierId, input.invoiceNumber, input.purchasedAt ?? now, input.notes, total, input.attachmentId, actor.userId ?? 'system', now, now,
      );
      for (const item of input.items) {
        const p = this.productRow(item.productId);
        if (!bool(p.stock_tracked)) throw conflict(`${p.name} não tem controle de estoque.`, 'NOT_TRACKED');
        // Quantidade em embalagens (2 fardos de 12) ou direto em unidades soltas (30 latas, 2.500 ml).
        const packageQty = item.packageQty ?? Number(p.package_qty);
        const qty = entryQtyMilli(item, packageQty);
        if (!Number.isSafeInteger(qty) || qty <= 0) throw badRequest(`Confira a quantidade de ${p.name}: ela deve ser maior que zero.`, 'INVALID_QTY');
        const packagesMilli = item.packages !== undefined ? Math.round(item.packages * 1000) : Math.round((qty * 1000) / packageQty);
        const unitCost = unitCostFromPurchase(item.totalCostCents, qty);
        const itemId = this.ctx.id();
        this.ctx.db.run(
          `INSERT INTO purchase_items (id, purchase_id, product_id, packages_milli, package_qty, qty, total_cost_cents, unit_cost_e4, expires_on, lot_code)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          itemId, id, item.productId, packagesMilli, packageQty, qty, item.totalCostCents, unitCost, item.expiresOn, item.lotCode,
        );
        this.move({
          productId: item.productId, type: 'purchase', delta: qty, refType: 'purchase_item', refId: itemId,
          reason: input.invoiceNumber ? `NF ${input.invoiceNumber}` : 'Entrada de mercadoria', userId: actor.userId, unitCostE4: unitCost,
        });
        if (item.expiresOn) {
          this.ctx.db.run(
            `INSERT INTO stock_lots (id, product_id, purchase_item_id, lot_code, expires_on, qty_received, qty_remaining, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            this.ctx.id(), item.productId, itemId, item.lotCode, item.expiresOn, qty, qty, now, now,
          );
          if (!bool(p.expiry_tracked)) this.ctx.db.run('UPDATE products SET expiry_tracked = 1 WHERE id = ?', item.productId);
        }
      }
      if (input.supplierId) {
        // Fornecedor principal passa a ser o da última compra quando o produto não tem um.
        for (const item of input.items) {
          this.ctx.db.run('UPDATE products SET supplier_id = ? WHERE id = ? AND supplier_id IS NULL', input.supplierId, item.productId);
        }
      }
      this.ctx.audit(actor, 'stock.purchase', 'purchase', id, { items: input.items.length, totalCents: total, invoice: input.invoiceNumber });
      return { id, totalCents: total };
    });
  }

  purchases(actor: Actor, limit = 100) {
    requirePerm(actor, 'stock.view');
    const rows = this.ctx.db.all(
      `SELECT pu.*, s.name AS supplier_name, u.name AS created_by_name,
              (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id) AS item_count
       FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN users u ON u.id = pu.created_by
       ORDER BY pu.purchased_at DESC LIMIT ?`,
      limit,
    );
    return rows.map((r) => ({
      ...r,
      items: this.ctx.db.all(
        `SELECT i.*, p.name AS product_name, p.measure, p.package_label, p.unit_label
         FROM purchase_items i JOIN products p ON p.id = i.product_id WHERE i.purchase_id = ?`,
        String(r.id),
      ),
    }));
  }

  // ------------------------------------------------------- ajustes e inventário

  adjust(actor: Actor, raw: unknown) {
    requirePerm(actor, 'stock.adjust');
    const input = adjustmentSchema.parse(raw);
    return this.ctx.tx(() => {
      const p = this.productRow(input.productId);
      const delta = input.countedQty - Number(p.stock_qty);
      if (delta === 0) return { delta: 0 };
      const refId = this.ctx.id();
      const r = this.move({
        productId: input.productId, type: 'adjustment', delta, refType: 'adjustment', refId, reason: input.reason,
        userId: actor.userId, allowNegative: true,
      });
      this.ctx.audit(actor, 'stock.adjusted', 'product', input.productId, { from: p.stock_qty, to: input.countedQty, reason: input.reason });
      return { delta, balance: r.balanceAfter };
    });
  }

  inventory(actor: Actor, raw: unknown) {
    requirePerm(actor, 'stock.adjust');
    const input = inventorySchema.parse(raw);
    const id = this.ctx.id();
    return this.ctx.tx(() => {
      const now = this.ctx.nowIso();
      this.ctx.db.run('INSERT INTO inventories (id, notes, created_by, created_at) VALUES (?,?,?,?)', id, input.notes, actor.userId ?? 'system', now);
      const result: { productId: string; name: string; expected: number; counted: number; diff: number; costCents: number }[] = [];
      for (const item of input.items) {
        const p = this.productRow(item.productId);
        const d = divergence(Number(p.stock_qty), item.countedQty);
        const cost = costOf(Math.abs(d.diff), Number(p.unit_cost_e4));
        this.ctx.db.run(
          'INSERT INTO inventory_items (id, inventory_id, product_id, expected_qty, counted_qty, diff, cost_cents) VALUES (?,?,?,?,?,?,?)',
          this.ctx.id(), id, item.productId, d.expected, d.counted, d.diff, cost,
        );
        if (d.diff !== 0) {
          this.move({
            productId: item.productId, type: 'inventory', delta: d.diff, refType: 'inventory', refId: id,
            reason: 'Inventário', userId: actor.userId, allowNegative: true,
          });
        }
        result.push({ productId: item.productId, name: String(p.name), expected: d.expected, counted: d.counted, diff: d.diff, costCents: cost });
      }
      this.ctx.audit(actor, 'stock.inventory', 'inventory', id, { items: result.length, divergences: result.filter((r) => r.diff !== 0).length });
      return { id, items: result };
    });
  }

  inventories(actor: Actor) {
    requirePerm(actor, 'stock.view');
    return this.ctx.db.all(
      `SELECT i.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM inventory_items x WHERE x.inventory_id = i.id) AS item_count,
              (SELECT COUNT(*) FROM inventory_items x WHERE x.inventory_id = i.id AND x.diff <> 0) AS divergence_count,
              (SELECT COALESCE(SUM(CASE WHEN x.diff < 0 THEN x.cost_cents ELSE 0 END),0) FROM inventory_items x WHERE x.inventory_id = i.id) AS shortage_cost_cents
       FROM inventories i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 50`,
    );
  }

  inventoryDetail(actor: Actor, id: string) {
    requirePerm(actor, 'stock.view');
    return this.ctx.db.all(
      `SELECT x.*, p.name AS product_name, p.measure FROM inventory_items x JOIN products p ON p.id = x.product_id WHERE x.inventory_id = ? ORDER BY p.name`,
      id,
    );
  }

  // ------------------------------------------------------------ consultas

  movements(actor: Actor, filter: { productId?: string; type?: string; from?: string; to?: string; limit?: number }) {
    requirePerm(actor, 'stock.view');
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.productId) where.push('m.product_id = ?'), params.push(filter.productId);
    if (filter.type) where.push('m.type = ?'), params.push(filter.type);
    if (filter.from) where.push('m.created_at >= ?'), params.push(filter.from);
    if (filter.to) where.push('m.created_at < ?'), params.push(filter.to);
    params.push(Math.min(filter.limit ?? 200, 1000));
    return this.ctx.db.all(
      `SELECT m.*, p.name AS product_name, p.measure, p.package_qty, p.package_label, p.unit_label, u.name AS user_name FROM stock_movements m
       JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT ?`,
      ...params,
    );
  }

  lots(actor: Actor, withinDays = 30) {
    requirePerm(actor, 'stock.view');
    const today = localDate(this.ctx.clock.now());
    const limit = localDate(new Date(this.ctx.clock.now().getTime() + withinDays * 86_400_000));
    return this.ctx.db
      .all(
        `SELECT l.*, p.name AS product_name, p.measure, p.package_qty, p.package_label, p.unit_label FROM stock_lots l JOIN products p ON p.id = l.product_id
         WHERE l.qty_remaining > 0 AND l.expires_on <= ? ORDER BY l.expires_on`,
        limit,
      )
      .map((l) => ({ ...l, expired: String(l.expires_on) < today }));
  }

  /** Alertas abertos com sugestão de reposição. */
  alerts(actor: Actor) {
    requirePerm(actor, 'stock.view');
    return this.ctx.db
      .all(
        `SELECT a.id, a.created_at, p.id AS product_id, p.name, p.internal_code, p.measure, p.stock_qty, p.min_stock, p.package_qty, p.package_label,
                p.unit_label, s.name AS supplier_name, s.phone AS supplier_phone
         FROM stock_alerts a JOIN products p ON p.id = a.product_id LEFT JOIN suppliers s ON s.id = p.supplier_id
         WHERE a.status = 'open' ORDER BY (p.stock_qty * 1.0 / MAX(p.min_stock, 1)), p.name`,
      )
      .map((a) => ({
        ...a,
        level: stockLevel(Number(a.stock_qty), Number(a.min_stock)),
        suggestion: restockSuggestion(Number(a.stock_qty), Number(a.min_stock), Number(a.package_qty)),
      }));
  }
}
