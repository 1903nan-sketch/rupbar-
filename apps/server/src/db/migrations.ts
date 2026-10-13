/**
 * Esquema do banco local. Migrações são aplicadas em ordem e registradas em
 * `schema_migrations`; nunca edite uma migração já publicada — crie outra.
 *
 * Convenções:
 *  - ids: UUID v7 (TEXT); datas: ISO-8601 UTC (TEXT).
 *  - dinheiro: *_cents INTEGER; quantidades: milésimos da unidade-base (INTEGER).
 *  - movimentações financeiras e de estoque são imutáveis (append-only);
 *    correções geram novos lançamentos de estorno.
 */
import type { Db } from './db';
import { backfillProductCodes } from './product-codes';
import { SYNCED_TABLES } from './sync-tables';

const M001 = /* sql */ `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  original_name TEXT,
  stored_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE establishment (
  id TEXT PRIMARY KEY,
  trade_name TEXT NOT NULL,
  legal_name TEXT,
  cnpj TEXT,
  phone TEXT,
  address_json TEXT NOT NULL DEFAULT '{}',
  primary_color TEXT NOT NULL,
  secondary_color TEXT NOT NULL,
  logo_attachment_id TEXT REFERENCES attachments(id),
  cover_attachment_id TEXT REFERENCES attachments(id),
  instagram TEXT,
  facebook TEXT,
  whatsapp TEXT,
  website TEXT,
  owner_email TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  grants_json TEXT NOT NULL DEFAULT '[]',
  denies_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_version INTEGER NOT NULL,
  device_label TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT,
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX auth_events_user ON auth_events(user_id, created_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  data_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);
CREATE INDEX audit_created ON audit_log(created_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log é somente inclusão'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log é somente inclusão'); END;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  station TEXT NOT NULL DEFAULT 'none' CHECK (station IN ('kitchen','bar','none')),
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX categories_name ON categories(name COLLATE NOCASE);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cnpj TEXT,
  phone TEXT,
  email TEXT,
  contact_name TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  internal_code TEXT,
  barcode TEXT,
  description TEXT,
  supplier_id TEXT REFERENCES suppliers(id),
  photo_attachment_id TEXT REFERENCES attachments(id),
  measure TEXT NOT NULL CHECK (measure IN ('unit','volume','mass')),
  package_qty INTEGER NOT NULL DEFAULT 1000 CHECK (package_qty > 0),
  package_label TEXT,
  stock_tracked INTEGER NOT NULL DEFAULT 1,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  unit_cost_e4 INTEGER NOT NULL DEFAULT 0,
  expiry_tracked INTEGER NOT NULL DEFAULT 0,
  menu_visible INTEGER NOT NULL DEFAULT 1,
  station TEXT CHECK (station IS NULL OR station IN ('kitchen','bar','none')),
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX products_internal_code ON products(internal_code) WHERE internal_code IS NOT NULL;
CREATE UNIQUE INDEX products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_category ON products(category_id);

CREATE TABLE presentations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  menu_visible INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX presentations_product ON presentations(product_id);

-- Ficha técnica: o que cada apresentação consome do estoque.
CREATE TABLE presentation_components (
  id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  ingredient_product_id TEXT NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX components_presentation ON presentation_components(presentation_id);
CREATE INDEX components_ingredient ON presentation_components(ingredient_product_id);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  unit_cost_e4 INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  ref_type TEXT,
  ref_id TEXT,
  reason TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);
-- Impede baixa duplicada: uma movimentação por (origem, produto, tipo).
CREATE UNIQUE INDEX stock_movements_once ON stock_movements(ref_type, ref_id, product_id, type) WHERE ref_id IS NOT NULL;
CREATE INDEX stock_movements_product ON stock_movements(product_id, created_at);
CREATE INDEX stock_movements_created ON stock_movements(created_at);
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'movimentações de estoque são imutáveis'); END;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'movimentações de estoque são imutáveis'); END;

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES suppliers(id),
  invoice_number TEXT,
  purchased_at TEXT NOT NULL,
  notes TEXT,
  total_cents INTEGER NOT NULL,
  attachment_id TEXT REFERENCES attachments(id),
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE purchase_items (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  packages_milli INTEGER NOT NULL,
  package_qty INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  total_cost_cents INTEGER NOT NULL,
  unit_cost_e4 INTEGER NOT NULL,
  expires_on TEXT,
  lot_code TEXT
);
CREATE INDEX purchase_items_product ON purchase_items(product_id);

CREATE TABLE stock_lots (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  purchase_item_id TEXT REFERENCES purchase_items(id),
  lot_code TEXT,
  expires_on TEXT NOT NULL,
  qty_received INTEGER NOT NULL,
  qty_remaining INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX stock_lots_product ON stock_lots(product_id, expires_on);

CREATE TABLE inventories (
  id TEXT PRIMARY KEY,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES inventories(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  expected_qty INTEGER NOT NULL,
  counted_qty INTEGER NOT NULL,
  diff INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stock_alerts (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  stock_qty INTEGER NOT NULL,
  min_stock INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
-- No máximo um alerta aberto por produto (evita alertas repetidos).
CREATE UNIQUE INDEX stock_alerts_open ON stock_alerts(product_id) WHERE status = 'open';

CREATE TABLE comandas (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_cpf TEXT,
  table_label TEXT,
  responsible_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','canceled')),
  discount_cents INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT,
  service_fee_bp INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  canceled_by TEXT,
  canceled_at TEXT,
  cancel_reason TEXT,
  client_request_id TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX comandas_status ON comandas(status);
CREATE INDEX comandas_opened ON comandas(opened_at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  business_day TEXT NOT NULL,
  comanda_id TEXT NOT NULL REFERENCES comandas(id),
  client_request_id TEXT NOT NULL UNIQUE,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'desktop',
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX orders_number_day ON orders(business_day, number);
CREATE INDEX orders_comanda ON orders(comanda_id);

CREATE TABLE comanda_items (
  id TEXT PRIMARY KEY,
  comanda_id TEXT NOT NULL REFERENCES comandas(id),
  order_id TEXT REFERENCES orders(id),
  kind TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product','hookah')),
  presentation_id TEXT REFERENCES presentations(id),
  product_id TEXT REFERENCES products(id),
  product_name TEXT NOT NULL,
  presentation_name TEXT NOT NULL,
  category_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  station TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled')),
  cancel_reason TEXT,
  canceled_by TEXT,
  canceled_at TEXT,
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX comanda_items_comanda ON comanda_items(comanda_id);
CREATE INDEX comanda_items_order ON comanda_items(order_id);
CREATE INDEX comanda_items_created ON comanda_items(created_at);

CREATE TABLE order_tickets (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  station TEXT NOT NULL CHECK (station IN ('kitchen','bar')),
  status TEXT NOT NULL DEFAULT 'received',
  accepted_at TEXT,
  preparing_at TEXT,
  ready_at TEXT,
  delivered_at TEXT,
  canceled_at TEXT,
  called_at TEXT,
  call_count INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX order_tickets_station ON order_tickets(order_id, station);
CREATE INDEX order_tickets_status ON order_tickets(status, station);

CREATE TABLE pickup_calls (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES order_tickets(id),
  order_number INTEGER NOT NULL,
  customer_first_name TEXT,
  text TEXT NOT NULL,
  called_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE cash_sessions (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by TEXT NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  opening_balance_cents INTEGER NOT NULL,
  opening_notes TEXT,
  closed_by TEXT REFERENCES users(id),
  closed_at TEXT,
  counted_cash_cents INTEGER,
  expected_cash_cents INTEGER,
  difference_cents INTEGER,
  summary_json TEXT,
  closing_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
-- Apenas um caixa aberto por vez.
CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions(status) WHERE status = 'open';

CREATE TABLE cash_movements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES cash_sessions(id),
  type TEXT NOT NULL CHECK (type IN ('withdrawal','supply')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  attachment_id TEXT REFERENCES attachments(id),
  client_request_id TEXT UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cash_movements_session ON cash_movements(session_id);
CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT, 'movimentações de caixa são imutáveis'); END;
CREATE TRIGGER cash_movements_no_update BEFORE UPDATE OF amount_cents, type, session_id, created_by, created_at ON cash_movements BEGIN SELECT RAISE(ABORT, 'movimentações de caixa são imutáveis'); END;

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  comanda_id TEXT NOT NULL REFERENCES comandas(id),
  cash_session_id TEXT REFERENCES cash_sessions(id),
  method TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_cents INTEGER,
  change_cents INTEGER NOT NULL DEFAULT 0,
  payer_label TEXT,
  client_request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  reversed_by TEXT,
  reversed_at TEXT,
  reverse_reason TEXT,
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX payments_comanda ON payments(comanda_id);
CREATE INDEX payments_session ON payments(cash_session_id);
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'pagamentos são imutáveis; use estorno'); END;
CREATE TRIGGER payments_no_amount_update BEFORE UPDATE OF amount_cents, method, comanda_id, cash_session_id ON payments BEGIN SELECT RAISE(ABORT, 'pagamentos são imutáveis; use estorno'); END;

CREATE TABLE losses (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  occurred_at TEXT NOT NULL,
  registered_by TEXT,
  registered_by_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local','remote')),
  status TEXT NOT NULL CHECK (status IN ('pending_application','applied','conflict','rejected')),
  remote_command_id TEXT UNIQUE,
  client_request_id TEXT UNIQUE,
  applied_qty INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  attachment_id TEXT REFERENCES attachments(id),
  applied_at TEXT,
  resolution_note TEXT,
  resolved_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX losses_product ON losses(product_id);
CREATE INDEX losses_occurred ON losses(occurred_at);

CREATE TABLE hookahs (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model TEXT NOT NULL DEFAULT '',
  pricing_mode TEXT NOT NULL CHECK (pricing_mode IN ('fixed','per_period')),
  price_cents INTEGER NOT NULL,
  period_minutes INTEGER NOT NULL DEFAULT 60,
  tolerance_minutes INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'available',
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE hookah_status_history (
  id TEXT PRIMARY KEY,
  hookah_id TEXT NOT NULL REFERENCES hookahs(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  notes TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE hookah_sessions (
  id TEXT PRIMARY KEY,
  hookah_id TEXT NOT NULL REFERENCES hookahs(id),
  comanda_id TEXT NOT NULL REFERENCES comandas(id),
  customer_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','canceled')),
  pricing_json TEXT NOT NULL,
  charge_cents INTEGER,
  comanda_item_id TEXT REFERENCES comanda_items(id),
  rosh_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  client_request_id TEXT UNIQUE,
  created_by TEXT NOT NULL,
  finished_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Um aparelho só pode estar em uma sessão ativa.
CREATE UNIQUE INDEX hookah_sessions_active ON hookah_sessions(hookah_id) WHERE status = 'active';

CREATE TABLE hookah_consumptions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES hookah_sessions(id),
  rosh_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL CHECK (kind IN ('essence','coal')),
  qty INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX hookah_consumptions_session ON hookah_consumptions(session_id);

CREATE TABLE printers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('network','windows','file')),
  host TEXT,
  port INTEGER NOT NULL DEFAULT 9100,
  windows_name TEXT,
  file_path TEXT,
  paper INTEGER NOT NULL DEFAULT 80,
  codepage TEXT NOT NULL DEFAULT 'cp850',
  stations_json TEXT NOT NULL DEFAULT '[]',
  print_receipts INTEGER NOT NULL DEFAULT 0,
  auto_print INTEGER NOT NULL DEFAULT 1,
  beep INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY,
  printer_id TEXT NOT NULL REFERENCES printers(id),
  kind TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  title TEXT NOT NULL,
  payload BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','printing','done','failed','canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  reprint_of TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  printed_at TEXT
);
CREATE INDEX print_jobs_queue ON print_jobs(status, next_attempt_at);
CREATE INDEX print_jobs_ref ON print_jobs(ref_type, ref_id);

CREATE TABLE tv_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  revoked_at TEXT
);

CREATE TABLE tv_pairings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','claimed','expired')),
  device_id TEXT REFERENCES tv_devices(id),
  ip TEXT,
  user_agent TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Outbox transacional de sincronização: preenchida por gatilhos (ver sync-tables.ts).
CREATE TABLE sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX sync_outbox_entity ON sync_outbox(entity, entity_id);

-- Comandos vindos da nuvem já processados (idempotência).
CREATE TABLE remote_commands_applied (
  command_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  result_json TEXT,
  applied_at TEXT NOT NULL,
  acked_at TEXT
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  ref_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','discarded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX notifications_queue ON notifications(status, next_attempt_at);
`;

/**
 * 0.2: cartões numerados, venda rápida e novo modelo de narguilé.
 *  - comandas.card_number: número do cartão físico (único entre as abertas).
 *  - comandas.kind: 'regular' | 'quick' (venda rápida, paga na hora).
 *  - hookahs.owner: 'house' (aparelho do bar) | 'customer' (narguilé próprio do cliente).
 *  - hookah_sessions.mode: 'legacy' (cobrança na devolução) | 'house' | 'own' (cobrança por item na hora).
 *  - comanda_items.hookah_session_id: itens lançados por uma locação (aluguel, trocas de rosh).
 */
const M003 = /* sql */ `
ALTER TABLE comandas ADD COLUMN card_number INTEGER;
ALTER TABLE comandas ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular';
CREATE UNIQUE INDEX comandas_card_open ON comandas(card_number) WHERE status = 'open' AND card_number IS NOT NULL;
CREATE INDEX comandas_card ON comandas(card_number);
ALTER TABLE hookahs ADD COLUMN owner TEXT NOT NULL DEFAULT 'house';
ALTER TABLE hookah_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE comanda_items ADD COLUMN hookah_session_id TEXT;
CREATE INDEX comanda_items_hookah ON comanda_items(hookah_session_id);
`;

/**
 * 0.2: correções da conta mestre (proprietário). Movimentações continuam
 * imutáveis: "excluir" anula com motivo e "editar" anula e lança de novo.
 */
const M004 = /* sql */ `
ALTER TABLE cash_movements ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE cash_movements ADD COLUMN voided_by TEXT;
ALTER TABLE cash_movements ADD COLUMN voided_at TEXT;
ALTER TABLE cash_movements ADD COLUMN void_reason TEXT;
ALTER TABLE purchases ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE purchases ADD COLUMN canceled_by TEXT;
ALTER TABLE purchases ADD COLUMN canceled_at TEXT;
ALTER TABLE purchases ADD COLUMN cancel_reason TEXT;
`;

/**
 * 0.2: anúncios da TV de retirada (fotos e vídeos guardados no PC do bar).
 *  - arquivos em <dados>/tv-media; o conteúdo de um id nunca muda (cache imutável).
 *  - position: ordem de exibição; duration_s: tempo das fotos (vídeos tocam até o fim).
 *  - somente local: não é sincronizado com a nuvem.
 */
const M005 = /* sql */ `
CREATE TABLE tv_media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  original_name TEXT,
  title TEXT NOT NULL DEFAULT '',
  duration_s INTEGER NOT NULL DEFAULT 10,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tv_media_position ON tv_media(position);
`;

/**
 * 0.2: estoque autoexplicativo.
 *  - products.unit_label: nome da unidade avulsa ("lata") quando a embalagem
 *    de compra tem várias ("fardo" de 12, em package_label).
 *  - Código interno automático: produtos sem código recebem 0001, 0002… na
 *    ordem de cadastro, pulando códigos já usados (etapa em código, abaixo).
 *    A sequência 'product_code' continua de onde a migração parou.
 */
const M006 = /* sql */ `
ALTER TABLE products ADD COLUMN unit_label TEXT;
`;

export interface Migration {
  id: number;
  name: string;
  sql: string;
  /** Etapa opcional em código, executada na mesma transação, depois do SQL. */
  run?: (db: Db) => void;
}

export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'schema inicial', sql: M001 },
  { id: 2, name: 'gatilhos de sincronização', sql: syncTriggersSql() },
  { id: 3, name: 'cartões, venda rápida e narguilé por item', sql: M003 },
  { id: 4, name: 'correções da conta mestre', sql: M004 },
  { id: 5, name: 'anúncios da TV de retirada', sql: M005 },
  { id: 6, name: 'código automático e unidade avulsa dos produtos', sql: M006, run: (db) => void backfillProductCodes(db, new Date().toISOString()) },
];

/** Gera gatilhos que alimentam a outbox enquanto a sincronização estiver ativa. */
function syncTriggersSql(): string {
  const when = `(SELECT value FROM meta WHERE key = 'sync_enabled') = '1'`;
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  return SYNCED_TABLES.map(
    ({ table, entity }) => `
CREATE TRIGGER sync_${table}_ins AFTER INSERT ON ${table} WHEN ${when}
BEGIN INSERT INTO sync_outbox(entity, entity_id, created_at) VALUES ('${entity}', NEW.id, ${now}); END;
CREATE TRIGGER sync_${table}_upd AFTER UPDATE ON ${table} WHEN ${when}
BEGIN INSERT INTO sync_outbox(entity, entity_id, created_at) VALUES ('${entity}', NEW.id, ${now}); END;`,
  ).join('\n');
}

/** Migrações ainda não aplicadas (usado para fazer backup antes de atualizar). */
export function pendingMigrations(db: Db): number[] {
  const exists = db.value("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (!exists) return [];
  const done = new Set(db.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
  return MIGRATIONS.filter((m) => !done.has(m.id)).map((m) => m.id);
}

export function migrate(db: Db): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const done = new Set(db.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.tx(() => {
      db.exec(m.sql);
      m.run?.(db);
      db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    });
    applied.push(m.id);
  }
  return { applied };
}
