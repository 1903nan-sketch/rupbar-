import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createEnv, OWNER, setupEstablishment, type TestEnv } from './helpers';

let env: TestEnv;
afterEach(async () => {
  await env.app.close();
  env.s.close();
});

function nextMessage(ws: WebSocket, predicate: (m: { channel: string; type: string; data?: Record<string, unknown> }) => boolean) {
  return new Promise<{ channel: string; type: string; data?: Record<string, unknown> }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout aguardando evento')), 3000);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (predicate(m)) {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });
}

describe('tempo real pela rede local', () => {
  it('servidor HTTP real: WebSocket autenticado recebe eventos de pedidos; anônimo é recusado', async () => {
    env = await createEnv();
    await setupEstablishment(env);
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = env.app.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rupbar': '1' },
      body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(login.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);

    const anon = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    const closed = await new Promise<number>((resolve) => anon.on('close', (code) => resolve(code)));
    expect(closed).toBe(4401);

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`, { headers: { cookie } });
    const hello = await nextMessage(ws, (m) => m.type === 'hello');
    expect(hello.data!.channels).toEqual(expect.arrayContaining(['comandas', 'kitchen', 'tv']));

    const waiting = nextMessage(ws, (m) => m.type === 'comanda.opened');
    const res = await fetch(`${base}/api/comandas`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rupbar': '1', cookie },
      body: JSON.stringify({ customerName: 'Tempo Real' }),
    });
    expect(res.status).toBe(200);
    const evt = await waiting;
    expect(evt.channel).toBe('comandas');
    expect(evt.data!.number).toBe(1);
    // eventos não carregam dados pessoais, apenas identificadores
    expect(JSON.stringify(evt)).not.toContain('Tempo Real');
    ws.close();

    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, configured: true });
    const disc = await fetch(`${base}/api/discovery`);
    expect(disc.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('logotipo: aceita PNG verificado pelo conteúdo e recusa arquivo disfarçado', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const upload = (bytes: Buffer, name: string) => {
      const boundary = 'xyz';
      return env.app.inject({
        method: 'POST', url: '/api/settings/identity/logo', remoteAddress: '127.0.0.1',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-rupbar': '1', cookie: owner.cookie },
        payload: Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
          bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const ok = await upload(png, 'logo.png');
    expect(ok.statusCode).toBe(200);
    const logoUrl = ok.json().logoUrl as string;
    expect(logoUrl).toMatch(/^\/api\/files\//);
    // logotipo é público (tela de login e TV)
    const pub = await env.app.inject({ method: 'GET', url: logoUrl });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('image/png');
    const fake = await upload(Buffer.from('<script>alert(1)</script>'), 'logo.png');
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.code).toBe('UNSUPPORTED_FILE');
    await owner.ok('DELETE', '/api/settings/identity/logo');
    expect((await owner.ok('GET', '/api/branding')).logoUrl).toBeNull();
  });
});
