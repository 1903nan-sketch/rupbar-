import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { category, Client, createEnv, createStaff, setupEstablishment, uuid, type TestEnv } from './helpers';

const API_KEY = 'evo-chave-global-9f8e7d6c5b4a';
const BASE = 'https://evo.example.com';

interface Call {
  method: string;
  path: string;
  apikey: string | null;
  body: any;
}

/**
 * Evolution API falsa atrás de um `fetch` simulado. Responde como a v2
 * (ou como a v1, com `v1 = true`, que só aceita { textMessage: { text } }).
 */
class FakeEvolution {
  calls: Call[] = [];
  instances = new Map<string, 'open' | 'close' | 'connecting'>();
  v1 = false;
  down = false;
  html = false;
  qrCount = 0;

  private reply(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private notFound(name: string) {
    return this.reply(404, { status: 404, error: 'Not Found', response: { message: [`The "${name}" instance does not exist`] } });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    this.calls.push({ method, path: url.pathname + url.search, apikey: headers.apikey ?? null, body });
    if (this.html) return new Response('<html><body>Meu site</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.origin !== BASE) throw new TypeError('fetch failed');
    if (headers.apikey !== API_KEY) return this.reply(401, { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } });

    const [, group, action, name = ''] = url.pathname.split('/');
    const key = `${method} /${group}/${action}`;
    const state = this.instances.get(decodeURIComponent(name));
    switch (key) {
      case 'GET /instance/connectionState':
        if (!state) return this.notFound(name);
        return this.reply(200, { instance: { instanceName: name, state } });
      case 'POST /instance/create': {
        const n = body.instanceName as string;
        if (this.instances.has(n)) {
          return this.reply(403, { status: 403, error: 'Forbidden', response: { message: [`This name "${n}" is already in use.`] } });
        }
        this.instances.set(n, 'connecting');
        return this.reply(201, {
          instance: { instanceName: n, status: 'connecting' }, hash: 'token-da-instancia',
          qrcode: { pairingCode: null, code: '2@primeiro-qr', base64: 'data:image/png;base64,iVBORw0KGgo=', count: 1 },
        });
      }
      case 'GET /instance/connect':
        if (!state) return this.notFound(name);
        if (state === 'open') return this.reply(200, { instance: { instanceName: name, state: 'open' } });
        this.instances.set(name, 'connecting');
        this.qrCount++;
        return this.reply(200, { pairingCode: 'WZYEH1YY', code: `2@qr-${this.qrCount}`, base64: `data:image/png;base64,QR${this.qrCount}==`, count: this.qrCount });
      case 'GET /instance/fetchInstances':
        return this.reply(200, [{ name: url.searchParams.get('instanceName'), connectionStatus: 'open', ownerJid: '5511955554444@s.whatsapp.net', profileName: 'Bar da Marina' }]);
      case 'POST /instance/logout':
        // Esta versão só aceita DELETE (rota POST inexistente).
        return this.reply(404, { status: 404, error: 'Not Found', response: { message: [`Cannot POST ${url.pathname}`] } });
      case 'DELETE /instance/logout':
        if (!state) return this.notFound(name);
        this.instances.set(name, 'close');
        return this.reply(200, { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } });
      case 'POST /message/sendText': {
        if (!state) return this.notFound(name);
        if (body.number === '5511900000000') {
          return this.reply(400, { status: 400, error: 'Bad Request', response: { message: [{ jid: '5511900000000@s.whatsapp.net', exists: false, number: '5511900000000' }] } });
        }
        const ok = this.v1 ? typeof body.textMessage?.text === 'string' : typeof body.text === 'string';
        if (!ok) return this.reply(400, { status: 400, error: 'Bad Request', response: { message: [this.v1 ? 'textMessage is required' : 'text is required'] } });
        return this.reply(201, { key: { remoteJid: `${body.number}@s.whatsapp.net`, fromMe: true, id: uuid() }, status: 'PENDING' });
      }
      default:
        return this.reply(404, { status: 404, error: 'Not Found', response: { message: [`Cannot ${method} ${url.pathname}`] } });
    }
  };

  sends() {
    return this.calls.filter((c) => c.path.startsWith('/message/sendText'));
  }
}

let env: TestEnv;
let owner: Client;
let evo: FakeEvolution;

beforeEach(async () => {
  evo = new FakeEvolution();
  vi.stubGlobal('fetch', vi.fn(evo.fetch));
  env = await createEnv();
  owner = await setupEstablishment(env);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await env.app.close();
  env.s.close();
});

const creds = { baseUrl: 'evo.example.com/manager/', apiKey: API_KEY, instance: 'rupbar' };

async function activate(extra: Record<string, unknown> = {}) {
  evo.instances.set('rupbar', 'open');
  return owner.ok('PUT', '/api/notifications/whatsapp', { provider: 'evolution', ownerPhone: '(11) 97777-6666', evolution: creds, ...extra });
}

describe('Evolution API — configuração e segredo', () => {
  it('normaliza o endereço, guarda a chave cifrada e nunca a devolve para a tela', async () => {
    const saved = await activate();
    expect(saved.provider).toBe('evolution');
    expect(saved.evolution).toEqual({ baseUrl: BASE, instance: 'rupbar', hasApiKey: true });
    const cfg = await owner.ok('GET', '/api/notifications/whatsapp');
    expect(cfg.evolution).toEqual({ baseUrl: BASE, instance: 'rupbar', hasApiKey: true });
    expect(cfg.alerts).toEqual({ stockLow: true, cashClosed: false });
    expect(JSON.stringify(cfg)).not.toContain(API_KEY);
    expect(env.s.db.value<string>("SELECT value_json FROM settings WHERE key = 'whatsapp'")).not.toContain(API_KEY);

    // Ações do assistente também não devolvem nem registram a chave.
    const test = await owner.ok('POST', '/api/notifications/whatsapp/evolution/test', {});
    expect(JSON.stringify(test)).not.toContain(API_KEY);
    const audit = env.s.db.all<{ data_json: string | null }>('SELECT data_json FROM audit_log');
    expect(audit.some((a) => (a.data_json ?? '').includes(API_KEY))).toBe(false);

    // Em branco = mantém a chave; a requisição à Evolution usa a chave salva.
    await owner.ok('PUT', '/api/notifications/whatsapp', { provider: 'evolution', ownerPhone: '(11) 97777-6666', evolution: { baseUrl: BASE, apiKey: '', instance: 'rupbar' } });
    expect((await owner.ok('GET', '/api/notifications/whatsapp')).evolution.hasApiKey).toBe(true);
    expect(evo.calls.every((c) => c.apikey === API_KEY)).toBe(true);
  });

  it('trocar o endereço exige informar a chave de novo (a chave salva não vai para outro servidor)', async () => {
    await activate();
    const moved = await owner.fail('PUT', '/api/notifications/whatsapp', { provider: 'evolution', ownerPhone: '(11) 97777-6666', evolution: { baseUrl: 'https://outro.example.net' } });
    expect(moved.status).toBe(400);
    expect(moved.message).toMatch(/chave da API/);
    const before = evo.calls.length;
    const test = await owner.fail('POST', '/api/notifications/whatsapp/evolution/test', { baseUrl: 'https://outro.example.net' });
    expect(test.code).toBe('EVOLUTION_CONFIG');
    expect(evo.calls.length).toBe(before); // nada foi enviado ao outro endereço
  });

  it('valida o nome da instância e exige os dados ao ativar', async () => {
    const bad = await owner.fail('POST', '/api/notifications/whatsapp/evolution/test', { ...creds, instance: 'meu bar' });
    expect(bad.code).toBe('VALIDATION');
    const incomplete = await owner.fail('PUT', '/api/notifications/whatsapp', { provider: 'evolution', ownerPhone: '(11) 97777-6666' });
    expect(incomplete.message).toMatch(/Evolution/);
  });
});

describe('Evolution API — estados de conexão e assistente', () => {
  it('mapeia open/connecting/close e instância inexistente', async () => {
    const notFound = await owner.ok('POST', '/api/notifications/whatsapp/evolution/test', creds);
    expect(notFound).toMatchObject({ state: null, status: 'not_found', instance: 'rupbar', baseUrl: BASE });
    // Endereço e chave válidos ficam salvos para o assistente continuar.
    expect((await owner.ok('GET', '/api/notifications/whatsapp')).evolution).toEqual({ baseUrl: BASE, instance: 'rupbar', hasApiKey: true });

    for (const [state, status] of [['open', 'connected'], ['connecting', 'waiting_qr'], ['close', 'disconnected']] as const) {
      evo.instances.set('rupbar', state);
      const r = await owner.ok('GET', '/api/notifications/whatsapp/evolution/state');
      expect(r).toMatchObject({ state, status });
    }
    evo.instances.set('rupbar', 'open');
    const open = await owner.ok('GET', '/api/notifications/whatsapp/evolution/state');
    expect(open.profile).toEqual({ number: '5511955554444', name: 'Bar da Marina' });
  });

  it('cria a instância, mostra o QR (e o código de pareamento), detecta a conexão e desconecta', async () => {
    const created = await owner.ok('POST', '/api/notifications/whatsapp/evolution/instance', creds);
    expect(created).toMatchObject({ created: true, status: 'waiting_qr', qr: { base64: 'data:image/png;base64,iVBORw0KGgo=', code: '2@primeiro-qr' } });
    expect(evo.calls.find((c) => c.path === '/instance/create')?.body).toEqual({ instanceName: 'rupbar', qrcode: true, integration: 'WHATSAPP-BAILEYS' });
    const again = await owner.ok('POST', '/api/notifications/whatsapp/evolution/instance', {});
    expect(again.created).toBe(false); // "already in use" não é erro

    const qr = await owner.ok('GET', '/api/notifications/whatsapp/evolution/qr');
    expect(qr).toEqual({ status: 'waiting_qr', qr: { base64: 'data:image/png;base64,QR1==', code: '2@qr-1', pairingCode: 'WZYEH1YY' } });

    evo.instances.set('rupbar', 'open'); // o celular leu o QR
    expect((await owner.ok('GET', '/api/notifications/whatsapp/evolution/state')).status).toBe('connected');
    expect(await owner.ok('GET', '/api/notifications/whatsapp/evolution/qr')).toEqual({ status: 'connected', qr: null });

    const out = await owner.ok('POST', '/api/notifications/whatsapp/evolution/logout');
    expect(out.status).toBe('disconnected');
    expect(evo.calls.filter((c) => c.path === '/instance/logout/rupbar').map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(evo.instances.get('rupbar')).toBe('close');
  });

  it('erros com mensagens claras: servidor fora do ar, chave errada, endereço que não é Evolution', async () => {
    evo.down = true;
    const down = await owner.fail('POST', '/api/notifications/whatsapp/evolution/test', creds);
    expect(down).toMatchObject({ status: 502, code: 'EVOLUTION_UNREACHABLE' });
    expect(down.message).toMatch(/Não foi possível falar com a Evolution API em evo\.example\.com/);
    evo.down = false;

    const wrongKey = await owner.fail('POST', '/api/notifications/whatsapp/evolution/test', { ...creds, apiKey: 'chave-errada' });
    expect(wrongKey).toMatchObject({ status: 502, code: 'EVOLUTION_UNAUTHORIZED' });
    expect(wrongKey.message).toMatch(/chave da API/);
    // Nada foi salvo com dados inválidos.
    expect((await owner.ok('GET', '/api/notifications/whatsapp')).evolution.hasApiKey).toBe(false);

    evo.html = true;
    const site = await owner.fail('POST', '/api/notifications/whatsapp/evolution/test', creds);
    expect(site.code).toBe('EVOLUTION_BAD_URL');
    evo.html = false;

    await owner.ok('POST', '/api/notifications/whatsapp/evolution/test', creds);
    const missing = await owner.fail('GET', '/api/notifications/whatsapp/evolution/qr');
    expect(missing).toMatchObject({ status: 404, code: 'EVOLUTION_INSTANCE_NOT_FOUND' });
    expect(missing.message).toMatch(/Criar instância/);
  });
});

describe('Evolution API — envio', () => {
  it('mensagem de teste no formato v2 para 55 + DDD + número', async () => {
    await owner.ok('POST', '/api/notifications/whatsapp/evolution/test', creds);
    evo.instances.set('rupbar', 'open');
    await owner.ok('POST', '/api/notifications/whatsapp/evolution/send-test', { phone: '(21) 98888-1234' });
    const [send] = evo.sends();
    expect(send).toMatchObject({ method: 'POST', path: '/message/sendText/rupbar', apikey: API_KEY });
    expect(send!.body.number).toBe('5521988881234');
    expect(send!.body.text).toContain('Bar da Marina');
    expect(send!.body.textMessage).toBeUndefined();
    expect(evo.sends()).toHaveLength(1);
  });

  it('servidor antigo (v1): 400 no formato novo → repete uma vez com textMessage', async () => {
    evo.v1 = true;
    await activate();
    await owner.ok('POST', '/api/notifications/whatsapp/test');
    const sends = evo.sends();
    expect(sends).toHaveLength(2);
    expect(sends[0]!.body).toMatchObject({ number: '5511977776666', text: expect.any(String) });
    expect(sends[1]!.body).toMatchObject({ number: '5511977776666', textMessage: { text: sends[0]!.body.text } });
  });

  it('número sem WhatsApp: não repete e explica o problema', async () => {
    await activate();
    const r = await owner.fail('POST', '/api/notifications/whatsapp/evolution/send-test', { phone: '(11) 90000-0000' });
    expect(r.code).toBe('EVOLUTION_ERROR');
    expect(r.message).toMatch(/não tem WhatsApp/);
    expect(evo.sends()).toHaveLength(1);
  });

  it('alertas pela fila: estoque baixo e fechamento de caixa, com nova tentativa quando a Evolution está fora', async () => {
    await activate({ alerts: { stockLow: true, cashClosed: true } });
    const cat = await category(owner, 'Cervejas');
    const { id } = await owner.ok('POST', '/api/products', {
      name: 'Cerveja long neck', categoryId: cat, measure: 'unit', packageQty: 1000, minStock: 6000,
      presentations: [{ name: 'Unidade', priceCents: 1200 }],
    });
    await owner.ok('POST', '/api/stock/purchases', { items: [{ productId: id, packages: 10, packageQty: 1000, totalCostCents: 4500 }] });
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 10_000 });
    const c = await owner.ok('POST', '/api/comandas', { customerName: 'Zé' });
    const pres = (await owner.ok('GET', `/api/products/${id}`)).presentations[0].id;
    await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId: pres, quantity: 5 }] });
    await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'pix', amountCents: 6000, clientRequestId: uuid() });
    env.clock.advance(60_000);
    await owner.ok('POST', '/api/cash/close', { countedCashCents: 9_500 });
    expect(env.s.db.all<{ kind: string }>('SELECT kind FROM notifications ORDER BY created_at').map((n) => n.kind)).toEqual(['stock_low', 'cash_closed']);

    evo.down = true;
    expect(await env.s.notifications.processQueue()).toBe(0);
    expect(env.s.db.value<string>("SELECT last_error FROM notifications WHERE kind = 'stock_low'")).toMatch(/Não foi possível falar com a Evolution/);
    evo.down = false;
    env.clock.advance(5 * 60_000);
    expect(await env.s.notifications.processQueue()).toBe(2);
    const texts = evo.sends().map((s) => s.body.text as string);
    const stock = texts.find((t) => t.includes('alerta de estoque'));
    const cash = texts.find((t) => t.includes('caixa nº 1 fechado'));
    expect(stock).toContain('Cerveja long neck');
    expect(cash).toContain('Pix: R$ 60,00');
    expect(cash).toContain('falta de R$ 5,00');
    expect(evo.sends().every((s) => s.body.number === '5511977776666')).toBe(true);
  });

  it('respeita os avisos escolhidos (fechamento de caixa desligado por padrão)', async () => {
    await activate();
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    await owner.ok('POST', '/api/cash/close', { countedCashCents: 0 });
    expect(env.s.db.value('SELECT COUNT(*) FROM notifications')).toBe(0);
  });
});

describe('Evolution API — permissões', () => {
  it('somente quem altera configurações usa o assistente', async () => {
    await activate();
    const manager = await createStaff(env, owner, 'manager', 'Gerente Leo', 'leo@bar.com');
    const anon = new Client(env.app);
    const routes: ['GET' | 'POST', string, unknown?][] = [
      ['POST', '/api/notifications/whatsapp/evolution/test', creds],
      ['POST', '/api/notifications/whatsapp/evolution/instance', creds],
      ['GET', '/api/notifications/whatsapp/evolution/state'],
      ['GET', '/api/notifications/whatsapp/evolution/qr'],
      ['POST', '/api/notifications/whatsapp/evolution/logout', {}],
      ['POST', '/api/notifications/whatsapp/evolution/send-test', { phone: '(11) 97777-6666' }],
      ['GET', '/api/notifications/whatsapp'],
    ];
    const before = evo.calls.length;
    for (const [method, url, body] of routes) {
      expect((await manager.fail(method, url, body)).status).toBe(403);
      expect((await anon.fail(method, url, body)).status).toBe(401);
    }
    expect(evo.calls.length).toBe(before); // nenhuma chamada saiu para a Evolution
    expect((await owner.ok('GET', '/api/notifications/whatsapp/evolution/state')).status).toBe('connected');
  });
});
