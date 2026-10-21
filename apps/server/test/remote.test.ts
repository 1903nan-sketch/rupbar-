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
  it('aluguel com essência e carvão inclusos, troca de rosh, narguilé próprio e tabela de preços', async () => {
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

    // Tabela única de preços: fácil de alterar; garçom não altera.
    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    expect(await owner.ok('GET', '/api/hookah/pricing')).toEqual({ rentalCents: 2_000, roshSwapCents: 1_000, ownRoshCents: 1_500 });
    expect((await waiter.fail('PUT', '/api/hookah/pricing', { rentalCents: 1 })).status).toBe(403);
    await owner.ok('PUT', '/api/hookah/pricing', { rentalCents: 2_500, roshSwapCents: 1_200, ownRoshCents: 1_800 });

    const h = await owner.ok('POST', '/api/hookahs', { code: 'N-01', model: 'Zeus' });
    const c = await waiter.ok('POST', '/api/comandas', { customerName: 'Rafa', table: '2' });
    const session = await waiter.ok('POST', '/api/hookah-sessions', {
      hookahId: h.id, comandaId: c.id, clientRequestId: uuid(), coalProductId: coal.id, coalUnits: 3,
      essences: [{ productId: menta, qty: 8_000 }, { productId: uva, qty: 4_000 }], // mistura 2:1 de 12 g
    });
    expect(session).toMatchObject({ roshCount: 1, mode: 'house', chargeCents: 2_500 });
    expect((await owner.ok('GET', '/api/hookahs'))[0]).toMatchObject({ status: 'rented' });
    expect((await waiter.fail('POST', '/api/hookah-sessions', { hookahId: h.id, comandaId: c.id, clientRequestId: uuid() })).code).toBe('HOOKAH_UNAVAILABLE');

    // O aluguel entra na comanda na hora (já inclui essência e carvão).
    let d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items).toEqual([expect.objectContaining({ kind: 'hookah', name: 'Narguilé N-01', totalCents: 2_500 })]);

    env.clock.advance(65 * 60_000);
    const swapped = await waiter.ok('POST', `/api/hookah-sessions/${session.id}/rosh`, { essences: [{ productId: menta, qty: 12_000 }], coalProductId: coal.id, coalUnits: 2 });
    expect(swapped).toMatchObject({ roshCount: 2, chargeCents: 3_700 });
    expect((await owner.ok('GET', `/api/products/${menta}`)).stockQty).toBe(200_000 - 20_000);
    expect((await owner.ok('GET', `/api/products/${uva}`)).stockQty).toBe(200_000 - 4_000);
    expect((await owner.ok('GET', `/api/products/${coal.id}`)).stockQty).toBe(72_000 - 5_000);

    // Com narguilé em uso, o que impede o encerramento é só o saldo a pagar.
    d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect((await owner.fail('POST', `/api/comandas/${c.id}/close`, { expectedVersion: d.version })).code).toBe('BALANCE_DUE');

    // A devolução continua disponível para liberar o aparelho antes de a comanda fechar.
    const finished = await waiter.ok('POST', `/api/hookah-sessions/${session.id}/finish`, { sendToCleaning: true });
    expect(finished).toMatchObject({ status: 'finished', chargeCents: 3_700, roshCount: 2 });
    d = await waiter.ok('GET', `/api/comandas/${c.id}`);
    expect(d.items.map((i: { totalCents: number }) => i.totalCents)).toEqual([2_500, 1_200]);
    expect((await owner.ok('GET', '/api/hookahs'))[0].status).toBe('cleaning');
    expect((await waiter.fail('POST', `/api/hookahs/${h.id}/status`, { status: 'available' })).status).toBe(403);
    await owner.ok('POST', `/api/hookahs/${h.id}/status`, { status: 'available', notes: 'Limpo' });

    // Narguilé próprio: cliente compra essência + carvão a cada rosh; troca cortesia não cobra.
    const own = await waiter.ok('POST', '/api/hookah-sessions', {
      mode: 'own', ownLabel: 'do Rafa', comandaId: c.id, clientRequestId: uuid(), essences: [{ productId: uva, qty: 10_000 }], coalProductId: coal.id, coalUnits: 3,
    });
    expect(own).toMatchObject({ mode: 'own', owner: 'customer', chargeCents: 1_800 });
    await waiter.ok('POST', `/api/hookah-sessions/${own.id}/rosh`, { essences: [{ productId: uva, qty: 10_000 }], charge: false });
    const ownDone = await waiter.ok('POST', `/api/hookah-sessions/${own.id}/finish`, {});
    expect(ownDone.chargeCents).toBe(1_800);
    // O aparelho do cliente não aparece entre os narguilés da casa.
    expect((await owner.ok('GET', '/api/hookahs')).map((x: { code: string }) => x.code)).toEqual(['N-01']);

    const from = '2026-01-01T00:00:00.000Z';
    const to = '2027-01-01T00:00:00.000Z';
    const ind = await owner.ok('GET', `/api/hookah/indicators?from=${from}&to=${to}`);
    expect(ind).toMatchObject({ sessions: 2, roshes: 4, revenueCents: 5_500, essenceGramsMilli: 44_000, coalUnits: 8 });
    expect(ind.flavors.map((f: { name: string; qty: number }) => [f.name, f.qty])).toEqual([['Essência Uva', 24_000], ['Essência Menta', 20_000]]);
  });
});

describe('sabores do aluguel de narguilé', () => {
  it('ligados às essências de venda: o rosh baixa os gramas do mesmo pacote vendido no cardápio', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const essCat = await category(owner, 'Essências');
    const essence = async (name: string) => {
      const p = await owner.ok('POST', '/api/products', {
        name, categoryId: essCat, measure: 'mass', packageQty: 50_000,
        presentations: [{ name: 'Pacote fechado', priceCents: 4_500, components: [{ productId: null, qty: 50_000 }] }],
        initialStock: { packages: 4, totalCostCents: 10_000 },
      });
      return p.id as string;
    };
    const menta = await essence('Ziggy Menta 50 g');
    const uva = await essence('Zomo Uva 50 g');
    await essence('Adalya Love 66 50 g');
    // Sem sabores ligados, o aluguel oferece todas as essências.
    expect((await owner.ok('GET', '/api/hookah/supplies')).essences).toHaveLength(3);

    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    expect((await waiter.fail('PUT', '/api/hookah/flavors', { flavors: [] })).status).toBe(403);
    expect((await owner.fail('PUT', '/api/hookah/flavors', { flavors: [{ productId: menta, name: 'Menta' }, { productId: menta, name: 'Menta 2' }] })).code).toBe('FLAVOR_DUPLICATE');
    const saved = await owner.ok('PUT', '/api/hookah/flavors', { flavors: [{ productId: uva, name: 'Uva' }, { productId: menta, name: 'Menta' }] });
    expect(saved.map((f: { name: string; productName: string }) => [f.name, f.productName])).toEqual([['Uva', 'Zomo Uva 50 g'], ['Menta', 'Ziggy Menta 50 g']]);

    // O aluguel mostra só os sabores ligados, com o nome do sabor.
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    const c = await waiter.ok('POST', '/api/comandas', { cardNumber: 8 });
    const panel = await waiter.ok('GET', `/api/comandas/${c.id}/hookah`);
    expect(panel.essences.map((x: { id: string; name: string }) => [x.id, x.name])).toEqual([[uva, 'Uva'], [menta, 'Menta']]);
    await waiter.ok('POST', '/api/hookah-sessions', { comandaId: c.id, clientRequestId: uuid(), essences: [{ productId: menta, qty: 12_000 }] });
    expect((await owner.ok('GET', `/api/products/${menta}`)).stockQty).toBe(200_000 - 12_000);
    // O mesmo produto continua à venda em pacote fechado e baixa do mesmo estoque.
    const pack = (await owner.ok('GET', `/api/products/${menta}`)).presentations[0].id;
    await waiter.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pack, quantity: 1 }] });
    expect((await owner.ok('GET', `/api/products/${menta}`)).stockQty).toBe(200_000 - 12_000 - 50_000);

    // No celular, o garçom tira e põe sabores num toque (acabou a uva, chegou Love 66).
    const love = (await owner.ok('GET', '/api/products')).find((p: { name: string }) => p.name === 'Adalya Love 66 50 g').id;
    await waiter.ok('POST', '/api/hookah/flavors/toggle', { productId: uva, on: false });
    const options = await waiter.ok('POST', '/api/hookah/flavors/toggle', { productId: love, on: true });
    expect(options.filter((o: { on: boolean }) => o.on).map((o: { name: string }) => o.name).sort()).toEqual(['Adalya Love 66', 'Menta']);
    expect((await waiter.ok('GET', `/api/comandas/${c.id}/hookah`)).essences.map((x: { name: string }) => x.name)).toEqual(['Menta', 'Adalya Love 66']);
    // Lista vazia vale como "nenhum sabor" (não volta a mostrar tudo).
    await owner.ok('PUT', '/api/hookah/flavors', { flavors: [] });
    expect((await waiter.ok('GET', `/api/comandas/${c.id}/hookah`)).essences).toEqual([]);
  });

  it('primeiro toque parte das essências que já apareciam no aluguel', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const essCat = await category(owner, 'Essências');
    const mk = async (name: string) => (await owner.ok('POST', '/api/products', { name, categoryId: essCat, measure: 'mass', packageQty: 50_000, menuVisible: false })).id as string;
    const a = await mk('Ziggy Menta 50 g');
    await mk('Zomo Uva 50 g');
    // Comida em gramas não entra nem como opção.
    await owner.ok('POST', '/api/products', { name: 'Batata', categoryId: await category(owner, 'Porções'), measure: 'mass', packageQty: 1_000_000, menuVisible: false });
    let options = await owner.ok('GET', '/api/hookah/flavor-options');
    expect(options.map((o: { productName: string; on: boolean }) => [o.productName, o.on])).toEqual([['Ziggy Menta 50 g', true], ['Zomo Uva 50 g', true]]);
    options = await owner.ok('POST', '/api/hookah/flavors/toggle', { productId: a, on: false });
    expect(options.map((o: { name: string; on: boolean }) => [o.name, o.on])).toEqual([['Ziggy Menta', false], ['Zomo Uva', true]]);
  });
});

describe('narguilé sem devolução', () => {
  it('aluguel rápido sem aparelho, troca, pacote de essência fechado e encerramento junto com a comanda', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const essCat = await category(owner, 'Essências');
    const coalCat = await category(owner, 'Carvão');
    // Mesma essência: vai por grama no aluguel e é vendida em pacote fechado no cardápio.
    const menta = await owner.ok('POST', '/api/products', {
      name: 'Ziggy Menta', categoryId: essCat, measure: 'mass', packageQty: 50_000,
      presentations: [{ name: 'Pacote fechado 50 g', priceCents: 4_500, components: [{ productId: null, qty: 50_000 }] }],
    });
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: menta.id, packages: 4, packageQty: 50_000, totalCostCents: 10_000 }] });
    const coal = await owner.ok('POST', '/api/products', { name: 'Carvão de coco', categoryId: coalCat, measure: 'unit', packageQty: 72_000, menuVisible: false });
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: coal.id, packages: 1, packageQty: 72_000, totalCostCents: 3_600 }] });
    const n1 = await owner.ok('POST', '/api/hookahs', { code: 'N-01' });
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    // Comida em gramas (porção) nunca aparece como sabor de narguilé.
    await owner.ok('POST', '/api/products', { name: 'Batata', categoryId: await category(owner, 'Porções'), measure: 'mass', packageQty: 1_000_000, menuVisible: false });

    const waiter = await createStaff(env, owner, 'waiter', 'Davi', 'davi@bar.com');
    const c = await waiter.ok('POST', '/api/comandas', { cardNumber: 7, customerName: 'Rafa' });

    // Tudo o que o celular precisa numa chamada.
    let panel = await waiter.ok('GET', `/api/comandas/${c.id}/hookah`);
    expect(panel.pricing).toEqual({ rentalCents: 2_000, roshSwapCents: 1_000, ownRoshCents: 1_500 });
    expect(panel.devices.map((x: { code: string }) => x.code)).toEqual(['N-01']);
    expect(panel.essences.map((x: { name: string }) => x.name)).toEqual(['Ziggy Menta']);
    expect(panel.coals.map((x: { name: string }) => x.name)).toEqual(['Carvão de coco']);

    // Aluguel sem escolher aparelho: R$ 20 com essência e carvão, sem cobrar a essência.
    const rental = await waiter.ok('POST', '/api/hookah-sessions', {
      comandaId: c.id, clientRequestId: uuid(), essences: [{ productId: menta.id, qty: 12_000 }], coalProductId: coal.id, coalUnits: 3,
    });
    expect(rental).toMatchObject({ mode: 'house', owner: 'loose', chargeCents: 2_000 });
    await waiter.ok('POST', `/api/hookah-sessions/${rental.id}/rosh`, { essences: [{ productId: menta.id, qty: 12_000 }], coalProductId: coal.id, coalUnits: 2 });
    // Aparelho da lista alugado na mesma comanda.
    await waiter.ok('POST', '/api/hookah-sessions', { hookahId: n1.id, comandaId: c.id, clientRequestId: uuid() });
    // O aluguel rápido não aparece entre os aparelhos da casa.
    expect((await owner.ok('GET', '/api/hookahs')).map((x: { code: string; status: string }) => [x.code, x.status])).toEqual([['N-01', 'rented']]);
    panel = await waiter.ok('GET', `/api/comandas/${c.id}/hookah`);
    expect(panel.sessions.map((x: { title: string; chargedCents: number }) => [x.title, x.chargedCents])).toEqual([['Narguilé alugado', 3_000], ['Narguilé N-01', 2_000]]);
    expect(panel.devices).toEqual([]);

    // Cliente compra um pacote fechado: é um item do cardápio e baixa 50 g.
    const menu = await waiter.ok('GET', '/api/menu');
    const pack = menu.items.find((i: { productName: string }) => i.productName === 'Ziggy Menta');
    expect(pack).toMatchObject({ presentationName: 'Pacote fechado 50 g', priceCents: 4_500 });
    await waiter.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pack.presentationId, quantity: 1 }] });
    expect((await owner.ok('GET', `/api/products/${menta.id}`)).stockQty).toBe(200_000 - 24_000 - 50_000);

    let d = await owner.ok('GET', `/api/comandas/${c.id}`);
    expect(d.total).toBe(2_000 + 1_000 + 2_000 + 4_500);
    await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'pix', amountCents: d.remaining, clientRequestId: uuid() });
    d = await owner.ok('GET', `/api/comandas/${c.id}`);
    // Encerrar a comanda encerra os narguilés: sem devolução.
    await owner.ok('POST', `/api/comandas/${c.id}/close`, { expectedVersion: d.version });
    const sessions = await owner.ok('GET', '/api/hookah-sessions');
    expect(sessions.map((x: { status: string; charge_cents: number }) => [x.status, x.charge_cents]).sort()).toEqual([['finished', 2_000], ['finished', 3_000]]);
    expect((await owner.ok('GET', '/api/hookahs'))[0].status).toBe('cleaning');

    // Comanda cancelada com aluguel: a locação é cancelada e o aparelho volta.
    await owner.ok('POST', `/api/hookahs/${n1.id}/status`, { status: 'available' });
    const c2 = await waiter.ok('POST', '/api/comandas', { cardNumber: 8 });
    await waiter.ok('POST', '/api/hookah-sessions', { hookahId: n1.id, comandaId: c2.id, clientRequestId: uuid() });
    const d2 = await owner.ok('GET', `/api/comandas/${c2.id}`);
    await owner.ok('POST', `/api/comandas/${c2.id}/cancel`, { expectedVersion: d2.version, reason: 'Cliente desistiu', returnToStock: true });
    expect((await owner.ok('GET', '/api/hookahs'))[0].status).toBe('cleaning');
    expect((await owner.ok('GET', '/api/hookah-sessions?status=active'))).toEqual([]);
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
