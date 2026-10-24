import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBRL } from '@rupbar/core';
import {
  remoteCashCloseSchema, remoteCashOpenSchema, remoteComandaOpenSchema, remoteDiscountDecisionSchema, remoteDiscountSchema, remoteItemCancelSchema,
  remoteOrderSchema, remoteProductActiveSchema, remoteUserRemoveSchema,
} from '@rupbar/core/schemas';
import { Db } from '../db/db';
import { migrate, pendingMigrations } from '../db/migrations';
import { SecretBox } from '../lib/crypto';
import { EventBus } from '../lib/events';
import { silentLogger, type Logger } from '../lib/log';
import { systemClock, type Clock } from '../lib/time';
import { AdminService } from './admin';
import { AttachmentsService } from './attachments';
import { AuthService } from './auth';
import { CashService } from './cash';
import { CatalogService } from './catalog';
import { ComandasService } from './comandas';
import { Ctx, type ServerConfig } from './context';
import { HookahService } from './hookah';
import { ImportService } from './imports';
import { KitchenService } from './kitchen';
import { LossesService } from './losses';
import { NetworkService } from './network';
import { NotificationsService, type HttpSender } from './notifications';
import { PrintingService, type PrinterTransport } from './printing';
import { ReportsService } from './reports';
import { ResetService } from './reset';
import { SalesService } from './sales';
import { SettingsService } from './settings';
import { SetupService } from './setup';
import { StockService } from './stock';
import { SyncService, type CloudApi } from './sync';
import { TvService } from './tv';
import { TvMediaService } from './tv-media';
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
  // Atualização de versão: cópia de segurança antes de alterar o esquema.
  const pending = pendingMigrations(db);
  if (pending.length && !opts.dbPath) {
    const file = join(config.backupsDir, `pre-migracao-${pending.join('-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.backupTo(file);
    opts.log?.info('backup antes da migração', { file, pending });
  }
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
  const sales = new SalesService(ctx, comandas, cash);
  const admin = new AdminService(ctx, comandas, cash, stock);
  const kitchen = new KitchenService(ctx, settings);
  const losses = new LossesService(ctx, stock);
  const hookah = new HookahService(ctx, settings, stock, comandas);
  comandas.endHookahs = (actor, comandaId, outcome) => hookah.endForComanda(actor, comandaId, outcome);
  const printing = new PrintingService(ctx, settings, comandas, opts.printerTransport);
  const tvMedia = new TvMediaService(ctx);
  const tv = new TvService(ctx, settings, kitchen, tvMedia);
  const notifications = new NotificationsService(ctx, settings, opts.httpSender);
  const sync = new SyncService(ctx, settings, losses, opts.cloudApi);
  const network = new NetworkService(ctx);
  const reports = new ReportsService(ctx);
  const attachments = new AttachmentsService(ctx);
  const setup = new SetupService(ctx, settings, users, catalog, auth);
  const imports = new ImportService(ctx, catalog, stock);
  const reset = new ResetService(ctx);

  // Ligações entre módulos (evita dependências circulares).
  stock.onAlertOpened = (alertId, productId) => notifications.enqueueStockAlert(alertId, productId);
  comandas.onOrderCreated = (orderId) => {
    if (settings.operation().autoPrintOrders) printing.enqueueOrderTickets(orderId);
  };
  kitchen.onReprint = (ticketId, actor) => {
    const orderId = db.value<string>('SELECT order_id FROM order_tickets WHERE id = ?', ticketId);
    if (orderId) printing.enqueueOrderTickets(orderId, { reprint: true, ticketId, manual: true, createdBy: actor.userId });
  };
  cash.onSessionClosed = (sessionId) => {
    printing.printCashClose(sessionId, null);
    notifications.enqueueCashClosed(sessionId);
  };
  sales.onCompleted = ({ comandaId, orderId, printReceipt }, actor) => {
    const tickets = settings.operation().autoPrintOrders ? printing.enqueuePickupTicket(orderId, { createdBy: actor.userId }).length : 0;
    if (printReceipt) {
      try {
        printing.printBill(actor, comandaId);
      } catch (err) {
        // Sem impressora de contas a venda continua válida; só não sai o comprovante.
        ctx.log.warn('comprovante da venda rápida não impresso', { error: (err as Error).message });
      }
    }
    return tickets;
  };

  // Comandos do painel online: aplicados pelo proprietário (nome de quem enviou no histórico).
  const remote = (payload: unknown) => {
    const name = typeof (payload as { registeredByName?: unknown })?.registeredByName === 'string' ? String((payload as { registeredByName: string }).registeredByName) : '';
    return auth.ownerActor(name);
  };
  sync.register('comanda.open', (commandId, payload) => {
    const input = remoteComandaOpenSchema.parse(payload);
    const c = comandas.open(remote(payload), { ...input, clientRequestId: commandId });
    return { status: 'applied', message: `Comanda ${c.displayNumber ?? c.number} aberta.`, comandaId: c.id };
  });
  sync.register('order.create', (commandId, payload) => {
    const input = remoteOrderSchema.parse(payload);
    const o = comandas.createOrder(remote(payload), { comandaId: input.comandaId, clientRequestId: commandId, items: input.items, notes: null });
    return { status: 'applied', message: `Pedido ${o.number} lançado na comanda ${o.comandaDisplayNumber ?? o.comandaNumber}.`, orderId: o.id };
  });
  sync.register('comanda_item.cancel', (_commandId, payload) => {
    const input = remoteItemCancelSchema.parse(payload);
    comandas.cancelItem(remote(payload), input.itemId, { reason: input.reason, returnToStock: true });
    return { status: 'applied', message: 'Item tirado da comanda (estoque devolvido).' };
  });
  sync.register('cash.open', (_commandId, payload) => {
    const input = remoteCashOpenSchema.parse(payload);
    const s = cash.open(remote(payload), input);
    return { status: 'applied', message: `Caixa ${s.number} aberto.`, sessionId: s.id };
  });
  sync.register('cash.close', (_commandId, payload) => {
    const input = remoteCashCloseSchema.parse(payload);
    cash.close(remote(payload), input);
    return { status: 'applied', message: 'Caixa fechado.' };
  });
  sync.register('user.remove', (_commandId, payload) => {
    const input = remoteUserRemoveSchema.parse(payload);
    const u = users.remove(remote(payload), input.userId);
    return { status: 'applied', message: `${u.name} excluído(a).` };
  });
  sync.register('comanda.discount', (_commandId, payload) => {
    const input = remoteDiscountSchema.parse(payload);
    const c = comandas.applyDiscount(remote(payload), input.comandaId, input.discountCents, input.reason);
    return {
      status: 'applied',
      message: input.discountCents ? `Desconto de ${formatBRL(input.discountCents)} na ${c.label} (fica ${formatBRL(c.total)}).` : `Desconto tirado da ${c.label}.`,
    };
  });
  for (const [type, approve] of [['discount.approve', true], ['discount.reject', false]] as const) {
    sync.register(type, (_commandId, payload) => {
      const input = remoteDiscountDecisionSchema.parse(payload);
      const r = comandas.decideDiscount(remote(payload), input.requestId, approve, input.note);
      return { status: r.applied ? 'applied' : 'rejected', message: r.message };
    });
  }
  sync.register('product.set_active', (_commandId, payload) => {
    const input = remoteProductActiveSchema.parse(payload);
    const p = catalog.setActive(remote(payload), input.productId, input.active);
    return { status: 'applied', message: input.active ? `${p.name} voltou à venda.` : `${p.name} saiu da venda.` };
  });

  let kitchenSweep: NodeJS.Timeout | null = null;
  return {
    ctx, db, settings, auth, users, catalog, stock, comandas, cash, sales, admin, kitchen, losses, hookah, printing, tv, tvMedia, notifications, sync,
    network, reports, attachments, setup, imports, reset,
    startWorkers() {
      printing.start();
      kitchenSweep = setInterval(() => kitchen.sweepReady(), 30_000);
      kitchenSweep.unref?.();
      notifications.start();
      sync.start();
      network.start();
      void tv.detectTts();
    },
    stopWorkers() {
      printing.stop();
      if (kitchenSweep) clearInterval(kitchenSweep);
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
