import { PERMISSION_GROUPS, PERMISSIONS, OWNER_ONLY, SENSITIVE } from '@rupbar/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors';
import type { AttachmentKind } from '../services/attachments';
import { requirePerm, type Actor } from '../services/context';
import type { Services } from '../services';
import { listWindowsPrinters } from '../services/printing';
import { actorOf, isLoopback, RateLimiter, SESSION_COOKIE, setSessionCookie, TV_COOKIE, tokenFrom } from './app';

type Q = Record<string, string | undefined>;
type Handler = (req: FastifyRequest, actor: Actor, reply: FastifyReply) => unknown;

const id = (req: FastifyRequest) => (req.params as { id: string }).id;
const q = (req: FastifyRequest) => req.query as Q;
const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? null });

export function registerRoutes(app: FastifyInstance, s: Services, hub: { count(): number }): void {
  const loginLimiter = new RateLimiter(20, 5 * 60_000);
  const pairLimiter = new RateLimiter(30, 10 * 60_000);

  /** Registra rota autenticada. */
  const r = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, handler: Handler) => {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const actor = actorOf(req);
        const result = await handler(req, actor, reply);
        return result === undefined ? { ok: true } : result;
      },
    });
  };

  // ------------------------------------------------------------- públicas

  app.get('/api/health', async () => ({
    ok: true, app: 'rupbar', version: s.ctx.config.version, configured: s.settings.isConfigured(), time: s.ctx.nowIso(),
  }));

  app.get('/api/branding', async () => s.settings.branding());

  /** Descoberta na rede local (usada pelo celular para reencontrar o PC). */
  app.get('/api/discovery', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const b = s.settings.branding();
    return { app: 'rupbar', establishmentId: b.establishmentId, name: b.tradeName, port: s.ctx.config.port };
  });

  app.get('/api/files/:id', async (req, reply) => {
    const a = s.attachments.meta(id(req));
    if (!s.attachments.isPublic(a)) {
      if (!req.session) throw unauthorized();
      const allowed = ['reports.financial', 'cash.close', 'losses.view', 'stock.entry'] as const;
      if (!allowed.some((p) => req.session!.actor.permissions.has(p))) throw forbidden();
    }
    reply.header('Content-Type', String(a.mime));
    reply.header('Cache-Control', s.attachments.isPublic(a) ? 'public, max-age=86400, immutable' : 'private, no-store');
    reply.header('Content-Disposition', `inline; filename="${String(a.stored_name)}"`);
    return reply.send(s.attachments.read(a));
  });

  app.get('/api/setup/status', async (req) => ({ configured: s.settings.isConfigured(), isLocal: isLoopback(req.ip) }));

  app.post('/api/setup', async (req, reply) => {
    // A configuração inicial só pode ser feita no próprio PC do bar.
    if (!isLoopback(req.ip)) throw forbidden('A configuração inicial deve ser feita no computador do bar.', 'SETUP_LOCAL_ONLY');
    const { token, session } = await s.setup.run(req.body, meta(req));
    setSessionCookie(reply, token);
    return { user: session.user };
  });

  app.post('/api/auth/login', async (req, reply) => {
    loginLimiter.check(req.ip);
    const { token, session } = await s.auth.login(req.body, meta(req));
    setSessionCookie(reply, token);
    // O token também é devolvido para clientes que não usam cookie (aplicativo Windows).
    return { user: session.user, mustChangePassword: session.mustChangePassword, token };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = tokenFrom(req);
    if (token) s.auth.logout(token, meta(req));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.session) throw unauthorized();
    return { user: req.session.user, mustChangePassword: req.session.mustChangePassword };
  });

  app.post('/api/auth/change-password', async (req) => {
    if (!req.session) throw unauthorized();
    await s.auth.changePassword(req.session.actor, req.body, meta(req));
    return { ok: true };
  });

  // ------------------------------------------------------------------- TV

  app.post('/api/tv/pair/start', async (req) => {
    pairLimiter.check(req.ip);
    return s.tv.startPairing(meta(req));
  });

  app.post('/api/tv/pair/claim', async (req, reply) => {
    const body = z.object({ pairingId: z.string().uuid(), secret: z.string().min(10).max(100) }).parse(req.body);
    const result = s.tv.claim(body.pairingId, body.secret);
    if (result.status === 'approved') {
      reply.setCookie(TV_COOKIE, result.token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 5 * 365 * 24 * 3600 });
    }
    return result;
  });

  app.get('/api/tv/board', async (req) => {
    if (!req.tv && !req.session?.actor.permissions.has('kitchen.view')) {
      throw new AppError(401, 'TV_NOT_PAIRED', 'Esta TV não está autorizada.');
    }
    return s.tv.board();
  });

  app.get('/api/tv/calls/:id/audio', async (req, reply) => {
    if (!req.tv && !req.session) throw new AppError(401, 'TV_NOT_PAIRED', 'Esta TV não está autorizada.');
    const audio = await s.tv.callAudio(id(req));
    reply.header('Content-Type', 'audio/wav');
    reply.header('Cache-Control', 'private, max-age=600');
    return reply.send(audio);
  });

  r('POST', '/api/tv/approve', (req, a) => s.tv.approve(a, req.body));
  r('GET', '/api/tv/devices', (_req, a) => s.tv.devices(a));
  r('DELETE', '/api/tv/devices/:id', (req, a) => s.tv.revoke(a, id(req)));

  // ------------------------------------------------------- painel / sistema

  r('GET', '/api/dashboard', (_req, a) => s.reports.dashboard(a));
  r('GET', '/api/network', (_req, a) => {
    requirePerm(a, 'devices.manage');
    return { ...s.network.info(), connectedClients: hub.count() };
  });
  r('GET', '/api/permissions', () => ({ permissions: PERMISSIONS, groups: PERMISSION_GROUPS, ownerOnly: OWNER_ONLY, sensitive: SENSITIVE }));

  r('POST', '/api/system/backup', (_req, a) => {
    requirePerm(a, 'settings.manage');
    const file = `${s.ctx.config.backupsDir}/rupbar-${s.ctx.nowIso().replace(/[:.]/g, '-')}.db`;
    s.db.backupTo(file);
    s.ctx.tx(() => s.ctx.audit(a, 'system.backup', null, null, { file }));
    return { file };
  });

  // ------------------------------------------------------ funcionários

  r('GET', '/api/staff', () => s.users.staff());
  r('GET', '/api/users', (_req, a) => s.users.list(a));
  r('POST', '/api/users', (req, a) => s.users.create(a, req.body));
  r('PATCH', '/api/users/:id', (req, a) => s.users.update(a, id(req), req.body));
  r('POST', '/api/users/:id/reset-password', (req, a) => s.users.resetPassword(a, id(req)));
  r('GET', '/api/users/:id/access', (req, a) => s.users.accessHistory(a, id(req)));
  r('DELETE', '/api/users/:id/sessions/:sid', (req, a) => s.users.revokeSession(a, id(req), (req.params as { sid: string }).sid));
  r('GET', '/api/roles', (_req, a) => s.users.listRoles(a));
  r('POST', '/api/roles', (req, a) => s.users.createRole(a, req.body));
  r('PUT', '/api/roles/:id', (req, a) => s.users.updateRole(a, id(req), req.body));
  r('DELETE', '/api/roles/:id', (req, a) => s.users.deleteRole(a, id(req)));

  // -------------------------------------------------------- configurações

  r('GET', '/api/settings/identity', (_req, a) => s.settings.identity(a));
  r('PUT', '/api/settings/identity', (req, a) => s.settings.updateIdentity(a, req.body));
  for (const slot of ['logo', 'cover'] as const) {
    r('POST', `/api/settings/identity/${slot}`, async (req, a) => {
      requirePerm(a, 'settings.manage');
      const file = await readUpload(req);
      const saved = s.attachments.save(a, slot, file.data, file.filename);
      return s.settings.setImage(a, slot, saved.id);
    });
    r('DELETE', `/api/settings/identity/${slot}`, (_req, a) => s.settings.setImage(a, slot, null));
  }
  r('GET', '/api/settings/operation', (_req, a) => {
    requirePerm(a, 'settings.manage');
    return s.settings.operation();
  });
  r('PUT', '/api/settings/operation', (req, a) => s.settings.updateOperation(a, req.body));

  r('POST', '/api/attachments', async (req, a) => {
    const kind = z.enum(['receipt', 'loss_proof', 'invoice', 'product_photo']).parse(q(req).kind) as AttachmentKind;
    const needed = { receipt: 'cash.withdrawal', loss_proof: 'losses.confirm', invoice: 'stock.entry', product_photo: 'products.manage' } as const;
    requirePerm(a, needed[kind as keyof typeof needed]);
    const file = await readUpload(req);
    return s.attachments.save(a, kind, file.data, file.filename);
  });

  // ------------------------------------------------------ catálogo

  r('GET', '/api/categories', () => s.catalog.categories());
  r('POST', '/api/categories', (req, a) => s.catalog.createCategory(a, req.body));
  r('PUT', '/api/categories/:id', (req, a) => s.catalog.updateCategory(a, id(req), req.body));
  r('GET', '/api/suppliers', (_req, a) => {
    requirePerm(a, 'stock.view');
    return s.catalog.suppliers();
  });
  r('POST', '/api/suppliers', (req, a) => s.catalog.upsertSupplier(a, null, req.body));
  r('PUT', '/api/suppliers/:id', (req, a) => s.catalog.upsertSupplier(a, id(req), req.body));
  r('GET', '/api/products', (req, a) => s.catalog.products(a, { q: q(req).q, categoryId: q(req).categoryId, includeInactive: q(req).all === '1' }));
  r('GET', '/api/products/:id', (req, a) => s.catalog.product(a, id(req)));
  r('POST', '/api/products', (req, a) => s.catalog.saveProduct(a, null, req.body));
  r('PUT', '/api/products/:id', (req, a) => s.catalog.saveProduct(a, id(req), req.body));
  r('POST', '/api/products/:id/photo', async (req, a) => {
    requirePerm(a, 'products.manage');
    const file = await readUpload(req);
    const saved = s.attachments.save(a, 'product_photo', file.data, file.filename);
    s.catalog.setPhoto(a, id(req), saved.id);
    return saved;
  });
  r('DELETE', '/api/products/:id/photo', (req, a) => s.catalog.setPhoto(a, id(req), null));
  r('GET', '/api/menu', (_req, a) => s.catalog.menu(a));

  // ------------------------------------------------------ estoque

  r('POST', '/api/stock/purchases', (req, a) => s.stock.purchase(a, req.body));
  r('GET', '/api/stock/purchases', (_req, a) => s.stock.purchases(a));
  r('POST', '/api/stock/adjustments', (req, a) => s.stock.adjust(a, req.body));
  r('POST', '/api/stock/inventories', (req, a) => s.stock.inventory(a, req.body));
  r('GET', '/api/stock/inventories', (_req, a) => s.stock.inventories(a));
  r('GET', '/api/stock/inventories/:id', (req, a) => s.stock.inventoryDetail(a, id(req)));
  r('GET', '/api/stock/movements', (req, a) =>
    s.stock.movements(a, { productId: q(req).productId, type: q(req).type, from: q(req).from, to: q(req).to, limit: Number(q(req).limit) || undefined }),
  );
  r('GET', '/api/stock/lots', (req, a) => s.stock.lots(a, Number(q(req).days) || 30));
  r('GET', '/api/stock/alerts', (_req, a) => s.stock.alerts(a));

  // ------------------------------------------------------ comandas e pedidos

  r('GET', '/api/comandas', (req, a) =>
    s.comandas.list(a, { status: q(req).status, q: q(req).q, from: q(req).from, to: q(req).to, limit: Number(q(req).limit) || undefined }),
  );
  r('POST', '/api/comandas', (req, a) => s.comandas.open(a, req.body));
  r('GET', '/api/comandas/:id', (req, a) => s.comandas.detail(a, id(req)));
  r('GET', '/api/comandas/:id/contact', (req, a) => s.comandas.contact(a, id(req)));
  r('POST', '/api/comandas/:id/transfer', (req, a) => s.comandas.transfer(a, id(req), req.body));
  r('POST', '/api/comandas/:id/move-items', (req, a) => s.comandas.moveItems(a, id(req), req.body));
  r('POST', '/api/comandas/:id/discount', (req, a) => s.comandas.setDiscount(a, id(req), req.body));
  r('POST', '/api/comandas/:id/service-fee', (req, a) => s.comandas.setServiceFee(a, id(req), req.body));
  r('POST', '/api/comandas/:id/close', (req, a) => s.comandas.close(a, id(req), req.body));
  r('POST', '/api/comandas/:id/cancel', (req, a) => s.comandas.cancel(a, id(req), req.body));
  r('GET', '/api/comandas/:id/split', (req, a) => s.comandas.split(a, id(req), Number(q(req).parts)));
  r('POST', '/api/comandas/:id/print', (req, a) => ({ jobs: s.printing.printBill(a, id(req)) }));
  r('POST', '/api/comanda-items/:id/cancel', (req, a) => s.comandas.cancelItem(a, id(req), req.body));
  r('POST', '/api/orders', (req, a) => s.comandas.createOrder(a, req.body, q(req).source === 'mobile' ? 'mobile' : 'desktop'));
  r('GET', '/api/orders/mine', (_req, a) => s.comandas.myOrders(a));
  r('GET', '/api/orders/:id', (req, a) => {
    requirePerm(a, 'orders.view');
    return s.comandas.orderView(id(req));
  });

  // ------------------------------------------------------ caixa

  r('GET', '/api/cash/current', (_req, a) => s.cash.current(a));
  r('POST', '/api/cash/open', (req, a) => s.cash.open(a, req.body));
  r('POST', '/api/cash/movements', (req, a) => s.cash.movement(a, req.body));
  r('POST', '/api/cash/close', (req, a) => s.cash.close(a, req.body));
  r('GET', '/api/cash/sessions', (_req, a) => s.cash.sessions(a));
  r('GET', '/api/cash/sessions/:id', (req, a) => s.cash.sessionDetail(a, id(req)));
  r('POST', '/api/payments', (req, a) => s.cash.pay(a, req.body));
  r('POST', '/api/payments/:id/reverse', (req, a) => s.cash.reversePayment(a, id(req), req.body));

  // ------------------------------------------------------ cozinha / balcão

  r('GET', '/api/kitchen/board', (req, a) => {
    const station = z.enum(['kitchen', 'bar', 'all']).catch('all').parse(q(req).station);
    return s.kitchen.board(a, station);
  });
  r('POST', '/api/kitchen/tickets/:id/status', (req, a) => s.kitchen.updateStatus(a, id(req), req.body));
  r('POST', '/api/kitchen/tickets/:id/accept', (req, a) => s.kitchen.accept(a, id(req)));
  r('POST', '/api/kitchen/tickets/:id/call', (req, a) => s.kitchen.call(a, id(req)));
  r('POST', '/api/kitchen/tickets/:id/reprint', (req, a) => s.kitchen.reprint(a, id(req)));

  // ------------------------------------------------------ perdas

  r('GET', '/api/losses', (req, a) => s.losses.list(a, { status: q(req).status, from: q(req).from, to: q(req).to, productId: q(req).productId }));
  r('POST', '/api/losses', (req, a) => s.losses.registerLocal(a, req.body));
  r('POST', '/api/losses/:id/resolve', (req, a) => s.losses.resolve(a, id(req), req.body));

  // ------------------------------------------------------ narguilés

  r('GET', '/api/hookahs', (_req, a) => s.hookah.list(a));
  r('POST', '/api/hookahs', (req, a) => s.hookah.save(a, null, req.body));
  r('PUT', '/api/hookahs/:id', (req, a) => s.hookah.save(a, id(req), req.body));
  r('POST', '/api/hookahs/:id/status', (req, a) => s.hookah.changeStatus(a, id(req), req.body));
  r('GET', '/api/hookahs/:id/history', (req, a) => s.hookah.history(a, id(req)));
  r('GET', '/api/hookah-sessions', (req, a) => s.hookah.sessions(a, { status: q(req).status, from: q(req).from, to: q(req).to }));
  r('POST', '/api/hookah-sessions', (req, a) => s.hookah.start(a, req.body));
  r('GET', '/api/hookah-sessions/:id', (req, a) => s.hookah.session(a, id(req)));
  r('POST', '/api/hookah-sessions/:id/rosh', (req, a) => s.hookah.addRosh(a, id(req), req.body));
  r('POST', '/api/hookah-sessions/:id/finish', (req, a) => s.hookah.finish(a, id(req), req.body));
  r('GET', '/api/hookah/indicators', (req, a) => {
    const p = z.object({ from: z.string().datetime(), to: z.string().datetime() }).parse(q(req));
    return s.hookah.indicators(a, p.from, p.to);
  });

  // ------------------------------------------------------ impressoras

  r('GET', '/api/printers', (_req, a) => s.printing.list(a));
  r('GET', '/api/printers/windows', async (_req, a) => {
    requirePerm(a, 'printers.manage');
    return { printers: await listWindowsPrinters(), platform: process.platform };
  });
  r('POST', '/api/printers', (req, a) => s.printing.save(a, null, req.body));
  r('PUT', '/api/printers/:id', (req, a) => s.printing.save(a, id(req), req.body));
  r('DELETE', '/api/printers/:id', (req, a) => s.printing.remove(a, id(req)));
  r('POST', '/api/printers/:id/test', (req, a) => s.printing.test(a, id(req)));
  r('GET', '/api/print-jobs', (req, a) => s.printing.jobs(a, { status: q(req).status }));
  r('POST', '/api/print-jobs/:id/retry', (req, a) => s.printing.retry(a, id(req)));
  r('POST', '/api/print-jobs/:id/reprint', (req, a) => s.printing.reprintJob(a, id(req)));

  // ------------------------------------------------------ relatórios

  r('GET', '/api/reports/sales', (req, a) => s.reports.sales(a, q(req)));
  r('GET', '/api/reports/operational', (req, a) => s.reports.operational(a, q(req)));
  r('GET', '/api/reports/losses', (req, a) => s.reports.losses(a, q(req)));
  r('POST', '/api/reports/compare', (req, a) => s.reports.compareProducts(a, req.body));
  r('GET', '/api/reports/stock-by-category', (_req, a) => s.reports.stockByCategory(a));
  r('GET', '/api/audit', (req, a) => s.reports.audit(a, { entity: q(req).entity, entityId: q(req).entityId, action: q(req).action }));

  // ------------------------------------------------------ notificações

  r('GET', '/api/notifications/whatsapp', (_req, a) => s.notifications.config(a));
  r('PUT', '/api/notifications/whatsapp', (req, a) => s.notifications.saveConfig(a, req.body));
  r('POST', '/api/notifications/whatsapp/test', (_req, a) => s.notifications.test(a));
  r('GET', '/api/notifications', (_req, a) => s.notifications.list(a));

  // ------------------------------------------------------ sincronização

  r('GET', '/api/sync/status', () => s.sync.status());
  r('POST', '/api/sync/connect', (req, a) => s.sync.connect(a, req.body));
  r('POST', '/api/sync/disconnect', (_req, a) => s.sync.disconnect(a));
  r('POST', '/api/sync/run', async (_req, a) => {
    requirePerm(a, 'settings.manage');
    return s.sync.runOnce();
  });
  r('POST', '/api/sync/resync', (_req, a) => s.sync.resync(a));
}

async function readUpload(req: FastifyRequest): Promise<{ data: Buffer; filename: string | null }> {
  if (!req.isMultipart()) throw badRequest('Envie o arquivo como multipart/form-data.');
  const file = await req.file();
  if (!file) throw badRequest('Nenhum arquivo enviado.');
  const data = await file.toBuffer();
  return { data, filename: file.filename ?? null };
}
