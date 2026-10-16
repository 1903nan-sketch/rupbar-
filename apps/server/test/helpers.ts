import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/http/app';
import { setPasswordHashCost } from '../src/lib/crypto';
import { createServices, type CreateOptions, type Services } from '../src/services';

setPasswordHashCost(1 << 10);

export class FakeClock {
  constructor(public t = Date.parse('2026-03-14T22:00:00Z')) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export interface TestEnv {
  app: FastifyInstance;
  s: Services;
  clock: FakeClock;
  printed: { printer: string; bytes: Uint8Array }[];
  printerFail: { on: boolean };
  dataDir: string;
}

export async function createEnv(extra: Partial<CreateOptions> = {}): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rupbar-test-'));
  const clock = new FakeClock();
  const printed: TestEnv['printed'] = [];
  const printerFail = { on: false };
  const s = createServices({
    config: {
      dataDir,
      attachmentsDir: join(dataDir, 'attachments'),
      logsDir: join(dataDir, 'logs'),
      backupsDir: join(dataDir, 'backups'),
      port: 7420,
      uiDir: null,
      version: 'test',
    },
    dbPath: ':memory:',
    clock,
    masterKey: randomBytes(32),
    printerTransport: {
      async send(printer, data) {
        if (printerFail.on) throw new Error('Impressora desligada');
        printed.push({ printer: String(printer.printer_name ?? printer.name), bytes: data });
      },
    },
    ...extra,
  });
  const app = await buildApp(s);
  return { app, s, clock, printed, printerFail, dataDir };
}

/** Cliente HTTP com cookie de sessão. */
export class Client {
  cookie = '';
  constructor(
    private readonly app: FastifyInstance,
    public remoteAddress = '127.0.0.1',
  ) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      remoteAddress: this.remoteAddress,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-rupbar': '1',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
    });
    const set = res.cookies.find((c) => c.name === 'rupbar_session' || c.name === 'rupbar_tv');
    if (set) this.cookie = set.value ? `${set.name}=${set.value}` : '';
    return res;
  }

  async ok<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
    const res = await this.req(method, url, body);
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
    return res.json() as T;
  }

  async fail(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; code: string; message: string }> {
    const res = await this.req(method, url, body);
    if (res.statusCode < 400) throw new Error(`esperava erro em ${method} ${url}, recebeu ${res.statusCode}: ${res.body}`);
    const j = res.json() as { error: { code: string; message: string } };
    return { status: res.statusCode, code: j.error.code, message: j.error.message };
  }
}

export const OWNER = { name: 'Marina Souza', email: 'marina@bardamarina.com.br', password: 'Lua-Cheia-2026' };

export async function setupEstablishment(env: TestEnv, operation: Record<string, unknown> = {}): Promise<Client> {
  const owner = new Client(env.app);
  await owner.ok('POST', '/api/setup', {
    identity: { tradeName: 'Bar da Marina', primaryColor: '#FF9F0A', secondaryColor: '#1C1C1E', phone: '(11) 98888-7777' },
    owner: OWNER,
    operation: { allowNegativeStock: false, ...operation },
  });
  return owner;
}

/** Cria funcionário, faz o primeiro login e troca a senha temporária. */
export async function createStaff(env: TestEnv, owner: Client, roleKey: string, name: string, email: string): Promise<Client> {
  const roles = await owner.ok<{ id: string; key: string }[]>('GET', '/api/roles');
  const role = roles.find((r) => r.key === roleKey)!;
  const created = await owner.ok<{ id: string; temporaryPassword: string }>('POST', '/api/users', { name, email, roleId: role.id });
  const c = new Client(env.app, '192.168.0.50');
  await c.ok('POST', '/api/auth/login', { email, password: created.temporaryPassword });
  await c.ok('POST', '/api/auth/change-password', { currentPassword: created.temporaryPassword, newPassword: 'Senha-Forte-99' });
  return c;
}

export const uuid = () => randomUUID();

export async function category(owner: Client, name: string): Promise<string> {
  const cats = await owner.ok<{ id: string; name: string }[]>('GET', '/api/categories');
  return cats.find((c) => c.name === name)!.id;
}
