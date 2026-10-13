import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnv, setupEstablishment, type TestEnv } from './helpers';

describe('download do app Android do garçom', () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    await env?.app.close();
    env?.s.close();
    env = null;
  });

  it('responde 404 amigável quando o APK não está no PC', async () => {
    env = await createEnv();
    const res = await env.app.inject({ method: 'GET', url: '/download/rupbar-garcom.apk', remoteAddress: '192.168.0.50' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('ainda não está neste PC');
  });

  it('serve o APK da pasta de downloads sem login e informa a disponibilidade', async () => {
    env = await createEnv();
    const dir = join(env.dataDir, 'downloads');
    mkdirSync(dir, { recursive: true });
    const apk = Buffer.from('PK\u0003\u0004 apk de teste');
    writeFileSync(join(dir, 'rupbar-garcom.apk'), apk);

    const res = await env.app.inject({ method: 'GET', url: '/download/rupbar-garcom.apk', remoteAddress: '192.168.0.50' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toContain('rupbar-garcom.apk');
    expect(res.rawPayload.equals(apk)).toBe(true);

    const head = await env.app.inject({ method: 'HEAD', url: '/download/rupbar-garcom.apk', remoteAddress: '192.168.0.50' });
    expect(head.statusCode).toBe(200);

    const owner = await setupEstablishment(env);
    const net = await owner.ok<{ androidApp: { available: boolean; size: number; path: string } }>('GET', '/api/network');
    expect(net.androidApp).toMatchObject({ available: true, size: apk.length, path: '/download/rupbar-garcom.apk' });
  });

  it('descoberta na rede local mantém a assinatura usada pelo app', async () => {
    env = await createEnv();
    await setupEstablishment(env);
    const res = await env.app.inject({ method: 'GET', url: '/api/discovery', remoteAddress: '192.168.0.50' });
    expect(res.json()).toMatchObject({ app: 'rupbar', name: 'Bar da Marina', port: 7420 });
    expect(typeof res.json().establishmentId).toBe('string');
  });
});
