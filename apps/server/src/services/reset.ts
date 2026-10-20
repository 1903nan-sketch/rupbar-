import { testDataResetSchema } from '@rupbar/core/schemas';
import { join } from 'node:path';
import { SYNCED_TABLES } from '../db/sync-tables';
import { verifyPassword } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { requirePerm, type Actor, type Ctx } from './context';

/** Vendas, caixas e tudo o que sai nos relatórios (filhos antes dos pais). */
const SALES_TABLES = [
  'pickup_calls', 'print_jobs', 'order_tickets', 'hookah_consumptions', 'hookah_status_history', 'hookah_sessions',
  'payments', 'comanda_items', 'orders', 'comandas', 'cash_movements', 'cash_sessions', 'losses', 'notifications',
];
const STOCK_TABLES = ['stock_lots', 'purchase_items', 'purchases', 'inventory_items', 'inventories', 'stock_alerts', 'stock_movements'];
const PRODUCT_TABLES = ['product_option_groups', 'option_choices', 'option_groups', 'presentation_components', 'presentations', 'products'];

const SYNC_ON = "(SELECT value FROM meta WHERE key = 'sync_enabled') = '1'";
/** Travas que impedem apagar pagamentos e movimentações; saem só durante a limpeza e voltam na mesma transação. */
const GUARDS = ['payments_no_delete', 'cash_movements_no_delete', 'stock_movements_no_delete'];

/**
 * Conta mestre: apaga os dados do período de testes para começar a operação
 * do zero. Some de verdade (não é estorno): comandas, pedidos, pagamentos,
 * caixas, perdas, locações de narguilé, estoque e, se pedido, os produtos.
 * Usuários, configurações, impressoras, categorias, fornecedores e os
 * narguilés da casa ficam. Antes de apagar faz uma cópia do banco, e a
 * exclusão vai para o painel online pela sincronização.
 */
export class ResetService {
  constructor(private readonly ctx: Ctx) {}

  private count(table: string, where = ''): number {
    return Number(this.ctx.db.value(`SELECT COUNT(*) FROM ${table} ${where}`) ?? 0);
  }

  /** O que vai ser apagado, para o dono conferir antes. */
  preview(actor: Actor) {
    requirePerm(actor, 'admin.override');
    return {
      comandas: this.count('comandas'),
      orders: this.count('orders'),
      salesCents: Number(this.ctx.db.value("SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status = 'active'") ?? 0),
      cashSessions: this.count('cash_sessions'),
      openCashSessions: this.count('cash_sessions', "WHERE status = 'open'"),
      openComandas: this.count('comandas', "WHERE status = 'open'"),
      losses: this.count('losses'),
      hookahSessions: this.count('hookah_sessions'),
      products: this.count('products'),
      optionGroups: this.count('option_groups'),
      stockMovements: this.count('stock_movements'),
      purchases: this.count('purchases'),
      cloud: this.ctx.meta('sync_enabled') === '1',
    };
  }

  async reset(actor: Actor, raw: unknown) {
    requirePerm(actor, 'admin.override');
    const input = testDataResetSchema.parse(raw);
    const hash = actor.userId ? this.ctx.db.value<string>('SELECT password_hash FROM users WHERE id = ?', actor.userId) : null;
    if (!hash || !(await verifyPassword(input.password, hash))) throw badRequest('Senha incorreta.', 'BAD_PASSWORD');

    const before = this.preview(actor);
    const backup = `antes-de-apagar-testes-${this.ctx.nowIso().replace(/[:.]/g, '-')}.db`;
    this.ctx.db.backupTo(join(this.ctx.config.backupsDir, backup));

    const deleteProducts = !input.keepProducts;
    this.ctx.tx(() => {
      // As ligações entre tabelas são conferidas no fim: se faltar alguma, nada é apagado.
      this.ctx.db.exec('PRAGMA defer_foreign_keys = ON');
      const guards = this.ctx.db.all<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map(() => '?').join(',')})`, ...GUARDS,
      );
      for (const g of guards) this.ctx.db.exec(`DROP TRIGGER ${g.name}`);
      const now = this.ctx.nowIso();
      const tables = [...SALES_TABLES, ...STOCK_TABLES, ...(deleteProducts ? PRODUCT_TABLES : [])];
      // Avisa a nuvem: cada registro sincronizado vira "excluído" no painel online.
      const forget = (table: string, where = '') => {
        const t = SYNCED_TABLES.find((x) => x.table === table);
        if (!t) return;
        this.ctx.db.run(
          `INSERT INTO sync_outbox (entity, entity_id, created_at) SELECT '${t.entity}', id, ? FROM ${table} WHERE ${SYNC_ON}${where ? ` AND ${where}` : ''}`,
          now,
        );
      };
      for (const table of tables) {
        forget(table);
        this.ctx.db.run(`DELETE FROM ${table}`);
      }
      // Narguilé do cliente / avulso é criado a cada locação; os da casa voltam a ficar livres.
      forget('hookahs', "owner <> 'house'");
      this.ctx.db.run("DELETE FROM hookahs WHERE owner <> 'house'");
      this.ctx.db.run("UPDATE hookahs SET status = 'available', version = version + 1, updated_at = ? WHERE status = 'rented'", now);
      if (!deleteProducts) this.ctx.db.run('UPDATE products SET stock_qty = 0, version = version + 1, updated_at = ? WHERE stock_qty <> 0', now);
      for (const g of guards) this.ctx.db.exec(g.sql);
      // Numeração recomeça: comanda 1, caixa 1, pedido 1 (e código de produto 0001 se os produtos saíram).
      this.ctx.db.run(
        `DELETE FROM sequences WHERE name IN ('comanda', 'cash_session', 'own_hookah', 'loose_hookah'${deleteProducts ? ", 'product_code'" : ''}) OR name LIKE 'order:%'`,
      );
      this.ctx.audit(actor, 'admin.test_data_reset', null, null, {
        backup, keepProducts: input.keepProducts, comandas: before.comandas, salesCents: before.salesCents, cashSessions: before.cashSessions,
        products: deleteProducts ? before.products : 0, stockMovements: before.stockMovements,
      });
    });
    for (const channel of ['comandas', 'kitchen', 'tv', 'cash', 'stock', 'hookah', 'printing'] as const) {
      this.ctx.emit({ channel, type: 'data.reset' });
    }
    return { backup, deleted: before, keepProducts: input.keepProducts };
  }
}
