import type { CommandResult, PushResponse, RemoteCommand, SyncRecord } from '@rupbar/core';
import { afterEach, describe, expect, it } from 'vitest';
import { NetworkError, type CloudApi } from '../src/services/sync';
import { category, Client, createEnv, createStaff, OWNER, setupEstablishment, uuid, type TestEnv } from './helpers';

/** Nuvem falsa em memória que se comporta como as funções RPC do Supabase. */
class FakeCloud implements CloudApi {
  records = new Map<string, { version: number; data: Record<string, unknown> }>();
  commands: (RemoteCommand & { status: string; result?: CommandResult })[] = [];
  offline = false;
  pushes = 0;
  heartbeats = 0;
  private check() {
    if (this.offline) throw new NetworkError('ECONNREFUSED', 'fetch failed');
  }
  async signIn(_u: string, _k: string, email: string, password: string) {
    this.check();
    if (email !== OWNER.email || password !== 'senha-da-nuvem') throw new Error('credenciais inválidas');
    return { accessToken: 'jwt' };
  }
  async registerDevice(_u: string, _k: string, _t: string, args: { establishmentId: string }) {
    return { deviceId: uuid(), deviceSecret: 'segredo-do-dispositivo', establishmentId: args.establishmentId };
  }
  async push(_cfg: unknown, records: SyncRecord[]): Promise<PushResponse> {
    this.check();
    this.pushes++;
    for (const r of records) {
      const key = `${r.entity}:${r.id}`;
      const cur = this.records.get(key);
      if (!cur || cur.version < r.version) this.records.set(key, { version: r.version, data: r.data });
    }
    return { acked: records.map((r) => r.outboxId), rejected: [] };
  }
  async pull(): Promise<RemoteCommand[]> {
    this.check();
    return this.commands.filter((c) => c.status === 'pending' || c.status === 'delivered').map(({ status: _s, result: _r, ...c }) => c);
  }
  async ack(_cfg: unknown, results: CommandResult[]) {
    this.check();
    for (const r of results) {
      const c = this.commands.find((x) => x.id === r.commandId);
      if (c) Object.assign(c, { status: r.status, result: r });
    }
  }
  async heartbeat() {
    this.check();
    this.heartbeats++;
  }
  entity(entity: string) {
    return [...this.records.entries()].filter(([k]) => k.startsWith(`${entity}:`)).map(([, v]) => v.data);
  }
}

let env: TestEnv;
afterEach(async () => {
  await env.app.close();
  env.s.close();
});

async function beer(owner: Client, qty = 24) {
  const cat = await category(owner, 'Cervejas');
  const { id } = await owner.ok('POST', '/api/products', {
    name: 'Cerveja long neck', categoryId: cat, measure: 'unit', packageQty: 1000, minStock: 6000,
    presentations: [{ name: 'Unidade', priceCents: 1200 }],
  });
  await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: id, packages: qty, packageQty: 1000, totalCostCents: qty * 450 }] });
  return id as string;
}

describe('perdas', () => {
  it('somente o proprietário registra perdas; não ultrapassa o saldo; gera relatório com custo', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const manager = await createStaff(env, owner, 'manager', 'Gerente', 'g@bar.com');
    const id = await beer(owner);
    const body = { productId: id, qty: 2000, unit: 'un', reason: 'broken', notes: 'Caiu da prateleira', clientRequestId: uuid() };
    expect((await manager.fail('POST', '/api/losses', body)).status).toBe(403);
    const loss = await owner.ok('POST', '/api/losses', body);
    expect(loss).toMatchObject({ status: 'applied', appliedQty: 2000, costCents: 900, source: 'local' });
    expect((await owner.ok('POST', '/api/losses', body)).id).toBe(loss.id); // idempotente
    expect((await owner.ok('GET', `/api/products/${id}`)).stockQty).toBe(22_000);
    expect((await owner.fail('POST', '/api/losses', { ...body, qty: 99_000, clientRequestId: uuid() })).code).toBe('LOSS_EXCEEDS_STOCK');
    const rep = await owner.ok('GET', '/api/reports/losses?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z');
    expect(rep.totalCostCents).toBe(900);
    expect(rep.byReason[0]).toMatchObject({ reason: 'broken', label: 'Quebra', count: 1 });
  });
});

describe('sincronização com a nuvem', () => {
  it('envia snapshot minimizado, recebe perda remota, aplica uma única vez e confirma', async () => {
    const cloud = new FakeCloud();
    env = await createEnv({ cloudApi: cloud });
    const owner = await setupEstablishment(env);
    const id = await beer(owner);
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Maria', customerPhone: '11987654321', customerCpf: '52998224725' });

    expect((await owner.ok('GET', '/api/sync/status')).status).toBe('disabled');
    await owner.ok('POST', '/api/sync/connect', { supabaseUrl: 'https://abc.supabase.co', anonKey: 'anon-key-123456789012345', email: OWNER.email, password: 'senha-da-nuvem' });
    const cfg = env.s.db.value<string>("SELECT value_json FROM settings WHERE key = 'cloud'")!;
    expect(cfg).not.toContain('segredo-do-dispositivo'); // segredo cifrado em repouso
    const st = await env.s.sync.runOnce();
    expect(st).toMatchObject({ status: 'synced', pending: 0 });
    expect(cloud.heartbeats).toBe(1);

    // Minimização: sem CPF, telefone ou hash de senha na nuvem
    const comanda = cloud.entity('comanda').find((x) => x.id === c.id)!;
    expect(comanda.customer_name).toBe('Maria');
    expect(comanda).not.toHaveProperty('customer_cpf');
    expect(comanda).not.toHaveProperty('customer_phone');
    expect(comanda.has_cpf).toBe(1);
    expect(JSON.stringify([...cloud.records.values()])).not.toMatch(/scrypt|52998224725|987654321/);
    expect(cloud.entity('product').find((p) => p.id === id)!.stock_qty).toBe(24_000);

    // Alterações posteriores entram na outbox via gatilhos
    await owner.ok('POST', '/api/losses', { productId: id, qty: 1000, unit: 'un', reason: 'spilled' });
    expect(env.s.sync.status().pending).toBeGreaterThan(0);

    // Proprietário registra perda pelo site enquanto o PC está offline
    cloud.offline = true;
    const cmdId = uuid();
    cloud.commands.push({ id: cmdId, type: 'loss.register', payload: { productId: id, qty: 3000, unit: 'un', reason: 'expired', registeredByName: 'Marina (site)' }, createdAt: new Date().toISOString(), createdBy: null, status: 'pending' });
    const off = await env.s.sync.runOnce();
    expect(off.status).toBe('offline');
    expect((await owner.ok('GET', `/api/products/${id}`)).stockQty).toBe(23_000); // ainda não aplicada
    expect(cloud.commands[0]!.status).toBe('pending'); // "Aguardando aplicação"

    // Conexão volta: aplica uma vez, confirma, e o saldo sincroniza
    cloud.offline = false;
    await env.s.sync.runOnce();
    expect((await owner.ok('GET', `/api/products/${id}`)).stockQty).toBe(20_000);
    expect(cloud.commands[0]!.status).toBe('applied');
    // Reentrega do mesmo comando (ex.: confirmação perdida) não aplica de novo
    cloud.commands[0]!.status = 'delivered';
    await env.s.sync.runOnce();
    await env.s.sync.runOnce();
    expect((await owner.ok('GET', `/api/products/${id}`)).stockQty).toBe(20_000);
    expect(env.s.db.value("SELECT COUNT(*) FROM losses WHERE source = 'remote'")).toBe(1);
    expect(cloud.entity('product').find((p) => p.id === id)!.stock_qty).toBe(20_000);
    const remoteLoss = cloud.entity('loss').find((l) => l.remote_command_id === cmdId)!;
    expect(remoteLoss.status).toBe('applied');
  });

  it('perda remota maior que o saldo vira conflito e exige resolução segura no PC', async () => {
    const cloud = new FakeCloud();
    env = await createEnv({ cloudApi: cloud });
    const owner = await setupEstablishment(env);
    const id = await beer(owner, 5);
    await owner.ok('POST', '/api/sync/connect', { supabaseUrl: 'https://abc.supabase.co', anonKey: 'anon-key-123456789012345', email: OWNER.email, password: 'senha-da-nuvem' });
    cloud.commands.push({ id: uuid(), type: 'loss.register', payload: { productId: id, qty: 8000, unit: 'un', reason: 'missing' }, createdAt: '', createdBy: null, status: 'pending' });
    await env.s.sync.runOnce();
    expect(cloud.commands[0]!.status).toBe('conflict');
    expect((await owner.ok('GET', `/api/products/${id}`)).stockQty).toBe(5000); // nada aplicado
    const [loss] = await owner.ok('GET', '/api/losses?status=conflict');
    expect(loss.resolutionNote).toContain('Resolva no PC');
    expect((await owner.fail('POST', `/api/losses/${loss.id}/resolve`, { action: 'apply_full', note: 'Aplicar tudo' })).code).toBe('LOSS_EXCEEDS_STOCK');
    const resolved = await owner.ok('POST', `/api/losses/${loss.id}/resolve`, { action: 'apply_available', note: 'Conferido: sumiram 5' });
    expect(resolved).toMatchObject({ status: 'applied', appliedQty: 5000 });
    expect((await owner.ok('GET', `/api/products/${id}`)).stockQty).toBe(0);
    await env.s.sync.runOnce();
    expect(cloud.entity('loss')[0]!.status).toBe('applied');
  });

  it('comando desconhecido ou inválido é rejeitado sem afetar o estoque', async () => {
    const cloud = new FakeCloud();
    env = await createEnv({ cloudApi: cloud });
    const owner = await setupEstablishment(env);
    await owner.ok('POST', '/api/sync/connect', { supabaseUrl: 'https://abc.supabase.co', anonKey: 'anon-key-123456789012345', email: OWNER.email, password: 'senha-da-nuvem' });
    cloud.commands.push({ id: uuid(), type: 'loss.register', payload: { productId: uuid(), qty: 1, unit: 'un', reason: 'broken' }, createdAt: '', createdBy: null, status: 'pending' });
    cloud.commands.push({ id: uuid(), type: 'stock.delete_all' as never, payload: {}, createdAt: '', createdBy: null, status: 'pending' });
    await env.s.sync.runOnce();
    expect(cloud.commands.map((c) => c.status)).toEqual(['rejected', 'rejected']);
  });
});

describe('narguilés', () => {
  it('locação por período com essências em gramas, carvão, rosh adicional e limpeza', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const essCat = await category(owner, 'Essências');
    const coalCat = await category(owner, 'Carvão');
    const mkEss = async (name: string) => {
      const { id } = await owner.ok('POST', '/api/products', { name, categoryId: essCat, measure: 'mass', packageQty: 50_000, menuVisible: false });
      // mesma essência comprada em embalagens de 50 g e 100 g
      await owner.ok('POST', '/api/stock/purchases', {
        items: [
          { productId: id, packages: 2, packageQty: 50_000, totalCostCents: 5_000 },
          { productId: id, packages: 1, packageQty: 100_000, totalCostCents: 4_000 },
        ],
      });
      return id as string;
    };
    const menta = await mkEss('Essência Menta');
    const uva = await mkEss('Essência Uva');
    expect((await owner.ok('GET', `/api/products/${menta}`)).stockQty).toBe(200_000);
    const coal = await owner.ok('POST', '/api/products', { name: 'Carvão de coco', categoryId: coalCat, measure: 'unit', packageQty: 72_000, menuVisible: false });
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: coal.id, packages: 1, packageQty: 72_000, totalCostCents: 3_600 }] });

    const h = await owner.ok('POST', '/api/hookahs', { code: 'N-01', model: 'Zeus', pricingMode: 'per_period', priceCents: 3_000, periodMinutes: 60, toleranceMinutes: 10 });
    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const c = await waiter.ok('POST', '/api/comandas', { customerName: 'Rafa', table: '2' });
    const session = await waiter.ok('POST', '/api/hookah-sessions', {
      hookahId: h.id, comandaId: c.id, clientRequestId: uuid(), coalProductId: coal.id, coalUnits: 3,
      essences: [{ productId: menta, qty: 8_000 }, { productId: uva, qty: 4_000 }], // mistura 2:1 de 12 g
    });
    expect(session.roshCount).toBe(1);
    expect((await owner.ok('GET', '/api/hookahs'))[0]).toMatchObject({ status: 'rented' });
    expect((await waiter.fail('POST', '/api/hookah-sessions', { hookahId: h.id, comandaId: c.id, clientRequestId: uuid() })).code).toBe('HOOKAH_UNAVAILABLE');

    env.clock.advance(65 * 60_000);
    await waiter.ok('POST', `/api/hookah-sessions/${session.id}/rosh`, { essences: [{ productId: menta, qty: 12_000 }], coalProductId: coal.id, coalUnits: 2 });
    expect((await owner.ok('GET', `/api/products/${menta}`)).stockQty).toBe(200_000 - 20_000);
    expect((await owner.ok('GET', `/api/products/${uva}`)).stockQty).toBe(200_000 - 4_000);
    expect((await owner.ok('GET', `/api/products/${coal.id}`)).stockQty).toBe(72_000 - 5_000);

    let d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect((await owner.fail('POST', `/api/comandas/${c.id}/close`, { expectedVersion: d.version })).code).toBe('HOOKAH_ACTIVE');

    env.clock.advance(10 * 60_000); // 75 min no total → 2 períodos (tolerância de 10 min)
    const finished = await waiter.ok('POST', `/api/hookah-sessions/${session.id}/finish`, { sendToCleaning: true });
    expect(finished).toMatchObject({ status: 'finished', chargeCents: 6_000, roshCount: 2 });
    d = await waiter.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items).toEqual([expect.objectContaining({ kind: 'hookah', name: 'Narguilé N-01', totalCents: 6_000 })]);
    expect((await owner.ok('GET', '/api/hookahs'))[0].status).toBe('cleaning');
    expect((await waiter.fail('POST', `/api/hookahs/${h.id}/status`, { status: 'available' })).status).toBe(403);
    await owner.ok('POST', `/api/hookahs/${h.id}/status`, { status: 'available', notes: 'Limpo' });

    const from = '2026-01-01T00:00:00.000Z';
    const to = '2027-01-01T00:00:00.000Z';
    const ind = await owner.ok('GET', `/api/hookah/indicators?from=${from}&to=${to}`);
    expect(ind).toMatchObject({ sessions: 1, roshes: 2, revenueCents: 6_000, essenceGramsMilli: 24_000, avgGramsPerSessionMilli: 24_000, coalUnits: 5 });
    expect(ind.flavors[0]).toMatchObject({ name: 'Essência Menta', qty: 20_000 });
  });
});

describe('TV de retirada', () => {
  it('pareamento seguro por código: só a TV que iniciou recebe o token; acesso restrito ao painel', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const tv = new Client(env.app, '192.168.0.77');
    expect((await tv.fail('GET', '/api/tv/board')).code).toBe('TV_NOT_PAIRED');
    const p = await tv.ok('POST', '/api/tv/pair/start');
    expect(p.code).toMatch(/^\d{6}$/);
    expect((await tv.ok('POST', '/api/tv/pair/claim', { pairingId: p.pairingId, secret: p.secret })).status).toBe('pending');
    const intruder = new Client(env.app, '192.168.0.66');
    expect((await intruder.fail('POST', '/api/tv/pair/claim', { pairingId: p.pairingId, secret: 'x'.repeat(32) })).code).toBe('PAIRING_INVALID');
    const waiter = await createStaff(env, owner, 'waiter', 'Wes', 'w@bar.com');
    expect((await waiter.fail('POST', '/api/tv/approve', { code: p.code, name: 'TV Balcão' })).status).toBe(403);
    await owner.ok('POST', '/api/tv/approve', { code: p.code, name: 'TV Balcão' });
    const claimed = await tv.ok('POST', '/api/tv/pair/claim', { pairingId: p.pairingId, secret: p.secret });
    expect(claimed.status).toBe('approved');
    expect((await tv.fail('POST', '/api/tv/pair/claim', { pairingId: p.pairingId, secret: p.secret })).code).toBe('PAIRING_EXPIRED');
    const board = await tv.ok('GET', '/api/tv/board');
    expect(board.branding.tradeName).toBe('Bar da Marina');
    // o token da TV não dá acesso a nenhuma outra área
    expect((await tv.fail('GET', '/api/comandas')).status).toBe(401);
    expect((await tv.fail('GET', '/api/menu')).status).toBe(401);
    const devices = await owner.ok('GET', '/api/tv/devices');
    await owner.ok('DELETE', `/api/tv/devices/${devices[0].id}`);
    expect((await tv.fail('GET', '/api/tv/board')).code).toBe('TV_NOT_PAIRED');
  });
});

describe('alertas por WhatsApp', () => {
  it('envia uma vez quando houver conexão e descarta se o estoque já foi reposto', async () => {
    const sent: { url: string; body: string }[] = [];
    let online = false;
    env = await createEnv({
      httpSender: async (url, init) => {
        if (!online) throw new Error('fetch failed');
        sent.push({ url, body: String(init.body) });
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    const owner = await setupEstablishment(env);
    await owner.ok('PUT', '/api/notifications/whatsapp', { provider: 'webhook', ownerPhone: '(11) 97777-6666', webhook: { url: 'https://zap.example.com/send', token: 'tok-secreto' } });
    const cfg = await owner.ok('GET', '/api/notifications/whatsapp');
    expect(cfg.webhook).toEqual({ url: 'https://zap.example.com/send', hasToken: true });
    expect(env.s.db.value<string>("SELECT value_json FROM settings WHERE key = 'whatsapp'")).not.toContain('tok-secreto');

    const id = await beer(owner, 10);
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Zé' });
    const pres = (await owner.ok('GET', `/api/products/${id}`)).presentations[0].id;
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 5 }] });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 1 }] });
    expect(env.s.db.value("SELECT COUNT(*) FROM notifications")).toBe(1); // sem alertas repetidos
    await env.s.notifications.processQueue(); // offline: fica pendente
    expect(sent).toHaveLength(0);
    online = true;
    env.clock.advance(5 * 60_000);
    expect(await env.s.notifications.processQueue()).toBe(1);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ to: '+5511977776666' });
    expect(JSON.parse(sent[0]!.body).text).toContain('Cerveja long neck');

    // Novo episódio, mas a reposição chega antes do envio → mensagem descartada
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: id, packages: 20, packageQty: 1000, totalCostCents: 9000 }] });
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 18 }] });
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: id, packages: 20, packageQty: 1000, totalCostCents: 9000 }] });
    expect(await env.s.notifications.processQueue()).toBe(0);
    expect(env.s.db.value("SELECT status FROM notifications ORDER BY created_at DESC LIMIT 1")).toBe('discarded');
  });
});
