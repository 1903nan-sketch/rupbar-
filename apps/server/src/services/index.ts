import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../db/db';
import { migrate } from '../db/migrations';
import { SecretBox } from '../lib/crypto';
import { EventBus } from '../lib/events';
import { silentLogger, type Logger } from '../lib/log';
import { systemClock, type Clock } from '../lib/time';
import { AttachmentsService } from './attachments';
import { AuthService } from './auth';
import { CashService } from './cash';
import { CatalogService } from './catalog';
import { ComandasService } from './comandas';
import { Ctx, type ServerConfig } from './context';
import { HookahService } from './hookah';
import { KitchenService } from './kitchen';
import { LossesService } from './losses';
import { NetworkService } from './network';
import { NotificationsService, type HttpSender } from './notifications';
import { PrintingService, type PrinterTransport } from './printing';
import { ReportsService } from './reports';
import { SettingsService } from './settings';
import { SetupService } from './setup';
import { StockService } from './stock';
import { SyncService, type CloudApi } from './sync';
import { TvService } from './tv';
import { UsersService } from './users';

export interface CreateOptions {
  config: ServerConfig;
  dbPath?: string;
  clock?: Clock;
  log?: Logger;
  printerTransport?: PrinterTransport;
  cloudApi?: CloudApi;
  httpSender?: HttpSender;
  masterKey?: Buffer;
}

/** Chave mestra do cofre de segredos: criada na primeira execução. */
function loadMasterKey(dataDir: string): Buffer {
  const file = join(dataDir, 'master.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  const key = randomBytes(32);
  writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}

export type Services = ReturnType<typeof createServices>;

export function createServices(opts: CreateOptions) {
  const { config } = opts;
  for (const dir of [config.dataDir, config.attachmentsDir, config.logsDir, config.backupsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new Db(opts.dbPath ?? join(config.dataDir, 'rupbar.db'));
  migrate(db);
  const ctx = new Ctx(db, new EventBus(), opts.clock ?? systemClock, opts.log ?? silentLogger, config, new SecretBox(opts.masterKey ?? loadMasterKey(config.dataDir)));

  const settings = new SettingsService(ctx);
  const auth = new AuthService(ctx);
  const users = new UsersService(ctx, auth);
  const catalog = new CatalogService(ctx);
  const stock = new StockService(ctx, settings);
  catalog.bind(stock);
  const comandas = new ComandasService(ctx, settings, stock);
  const cash = new CashService(ctx, settings, comandas);
  const kitchen = new KitchenService(ctx, settings);
  const losses = new LossesService(ctx, stock);
  const hookah = new HookahService(ctx, settings, stock, comandas);
  const printing = new PrintingService(ctx, settings, comandas, opts.printerTransport);
  const tv = new TvService(ctx, settings, kitchen);
  const notifications = new NotificationsService(ctx, settings, opts.httpSender);
  const sync = new SyncService(ctx, settings, losses, opts.cloudApi);
  const network = new NetworkService(ctx);
  const reports = new ReportsService(ctx);
  const attachments = new AttachmentsService(ctx);
  const setup = new SetupService(ctx, settings, users, catalog, auth);

  // Ligações entre módulos (evita dependências circulares).
  stock.onAlertOpened = (alertId, productId) => notifications.enqueueStockAlert(alertId, productId);
  comandas.onOrderCreated = (orderId) => {
    if (settings.operation().autoPrintOrders) printing.enqueueOrderTickets(orderId);
  };
  kitchen.onReprint = (ticketId, actor) => {
    const orderId = db.value<string>('SELECT order_id FROM order_tickets WHERE id = ?', ticketId);
    if (orderId) printing.enqueueOrderTickets(orderId, { reprint: true, ticketId, manual: true, createdBy: actor.userId });
  };
  cash.onSessionClosed = (sessionId) => printing.printCashClose(sessionId, null);

  return {
    ctx, db, settings, auth, users, catalog, stock, comandas, cash, kitchen, losses, hookah, printing, tv, notifications, sync,
    network, reports, attachments, setup,
    startWorkers() {
      printing.start();
      notifications.start();
      sync.start();
      network.start();
      void tv.detectTts();
    },
    stopWorkers() {
      printing.stop();
      notifications.stop();
      sync.stop();
      network.stop();
    },
    close() {
      this.stopWorkers();
      db.close();
    },
  };
}
