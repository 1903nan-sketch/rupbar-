import type { SyncEntity } from '@rupbar/core';
import type { Db, Row } from './db';

export interface SyncedTable {
  table: string;
  entity: SyncEntity;
  /**
   * Monta o registro enviado à nuvem. Aplica minimização de dados (LGPD):
   * nada de hash de senha, CPF, telefone de cliente ou segredos.
   */
  serialize: (db: Db, row: Row) => Record<string, unknown>;
  /** A linha existe no PC, mas sai do painel (ex.: produto excluído). */
  hidden?: (row: Row) => boolean;
}

const omit = (row: Row, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
};

const asIs = (_db: Db, row: Row) => ({ ...row });

export const SYNCED_TABLES: SyncedTable[] = [
  {
    table: 'establishment',
    entity: 'establishment',
    serialize: (_db, row) => ({ ...omit(row, ['address_json']), address: JSON.parse(String(row.address_json ?? '{}')) }),
  },
  { table: 'categories', entity: 'category', serialize: asIs },
  { table: 'suppliers', entity: 'supplier', serialize: asIs },
  { table: 'products', entity: 'product', serialize: asIs, hidden: (row) => !!row.deleted_at },
  {
    table: 'presentations',
    entity: 'presentation',
    serialize: (db, row) => ({
      ...row,
      components: db.all('SELECT ingredient_product_id AS product_id, qty FROM presentation_components WHERE presentation_id = ?', row.id as string),
    }),
  },
  { table: 'stock_movements', entity: 'stock_movement', serialize: asIs },
  { table: 'stock_alerts', entity: 'stock_alert', serialize: asIs },
  { table: 'purchases', entity: 'purchase', serialize: (db, row) => ({ ...row, items: db.all('SELECT * FROM purchase_items WHERE purchase_id = ?', row.id as string) }) },
  {
    table: 'comandas',
    entity: 'comanda',
    serialize: (_db, row) => ({
      ...omit(row, ['customer_phone', 'customer_cpf', 'client_request_id']),
      has_phone: row.customer_phone ? 1 : 0,
      has_cpf: row.customer_cpf ? 1 : 0,
    }),
  },
  { table: 'comanda_items', entity: 'comanda_item', serialize: asIs },
  { table: 'orders', entity: 'order', serialize: (_db, row) => omit(row, ['client_request_id']) },
  { table: 'payments', entity: 'payment', serialize: (_db, row) => omit(row, ['client_request_id']) },
  { table: 'cash_sessions', entity: 'cash_session', serialize: asIs },
  { table: 'cash_movements', entity: 'cash_movement', serialize: (_db, row) => omit(row, ['client_request_id']) },
  { table: 'losses', entity: 'loss', serialize: (_db, row) => omit(row, ['client_request_id']) },
  { table: 'hookahs', entity: 'hookah', serialize: asIs },
  { table: 'hookah_sessions', entity: 'hookah_session', serialize: (_db, row) => omit(row, ['client_request_id']) },
  { table: 'hookah_consumptions', entity: 'hookah_consumption', serialize: asIs },
  {
    table: 'users',
    entity: 'user',
    serialize: (db, row) => ({
      id: row.id,
      name: row.name,
      // Excluído some do painel online.
      status: row.deleted_at ? 'removed' : row.status,
      role_id: row.role_id,
      role_name: db.value('SELECT name FROM roles WHERE id = ?', row.role_id as string) ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
  },
];

export const TABLE_BY_ENTITY = new Map(SYNCED_TABLES.map((t) => [t.entity, t]));
