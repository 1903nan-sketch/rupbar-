import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRange } from '../src/http/range';
import { sniffTvMedia } from '../src/services/tv-media';
import { Client, createEnv, createStaff, setupEstablishment, type TestEnv } from './helpers';

let env: TestEnv;
let closed: TestEnv | null = null;
afterEach(async () => {
  // testes de funções puras não criam ambiente novo
  if (!env || env === closed) return;
  closed = env;
  await env.app.close();
  env.s.close();
});

const PNG = (extra = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(extra)]);
const MP4 = (extra = 1000) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom\0\0\x02\0isomiso2', 'latin1'), randomBytes(extra)]);
const WEBM = (extra = 500) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), randomBytes(extra)]);
const HEIC = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), randomBytes(100)]);

/** Envia arquivo como multipart/form-data com o cookie do cliente. */
function upload(client: Client, bytes: Buffer, filename: string) {
  const boundary = `----rupbar${Math.random().toString(16).slice(2)}`;
  return env.app.inject({
    method: 'POST',
    url: '/api/tv/media',
    remoteAddress: client.remoteAddress,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-rupbar': '1', ...(client.cookie ? { cookie: client.cookie } : {}) },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

/** Pareia uma TV e devolve o cliente com o cookie da TV. */
async function pairTv(owner: Client): Promise<Client> {
  const tv = new Client(env.app, '192.168.0.77');
  const p = await tv.ok('POST', '/api/tv/pair/start');
  await owner.ok('POST', '/api/tv/approve', { code: p.code, name: 'TV Balcão' });
  expect((await tv.ok('POST', '/api/tv/pair/claim', { pairingId: p.pairingId, secret: p.secret })).status).toBe('approved');
  return tv;
}

const mediaFiles = () => readdirSync(env.s.tvMedia.dir);

describe('anúncios da TV: envio e permissões', () => {
  it('somente quem gerencia dispositivos envia, lista, edita e exclui; formatos conferidos pelo conteúdo', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const waiter = await createStaff(env, owner, 'waiter', 'Wes', 'w@bar.com');
    const anon = new Client(env.app, '192.168.0.90');

    expect((await upload(anon, PNG(), 'promo.png')).statusCode).toBe(401);
    expect((await upload(waiter, PNG(), 'promo.png')).statusCode).toBe(403);
    expect((await waiter.fail('GET', '/api/tv/media')).status).toBe(403);
    expect(mediaFiles()).toHaveLength(0);

    const events: string[] = [];
    env.s.ctx.bus.subscribe((e) => e.channel === 'tv' && events.push(e.type));

    const img = await upload(owner, PNG(), 'happy_hour-sexta.png');
    expect(img.statusCode).toBe(200);
    const imgBody = img.json();
    expect(imgBody).toMatchObject({ kind: 'image', mime: 'image/png', title: 'happy hour sexta', durationSeconds: 10, enabled: true, position: 1, missing: false });
    expect(events).toContain('tv.config');

    const vid = (await upload(owner, MP4(), 'drinks.mp4')).json();
    expect(vid).toMatchObject({ kind: 'video', mime: 'video/mp4', position: 2 });
    const webm = (await upload(owner, WEBM(), 'clip.webm')).json();
    expect(webm).toMatchObject({ kind: 'video', mime: 'video/webm', position: 3 });

    // arquivo disfarçado, foto HEIC e PDF são recusados (não ficam no disco)
    const fake = await upload(owner, Buffer.from('isto não é um vídeo, é texto puro com extensão trocada'), 'filme.mp4');
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.code).toBe('UNSUPPORTED_FILE');
    expect((await upload(owner, HEIC(), 'foto.mp4')).json().error.code).toBe('UNSUPPORTED_FILE');
    expect((await upload(owner, Buffer.from('%PDF-1.7 qualquer coisa'), 'cardapio.pdf')).json().error.code).toBe('UNSUPPORTED_FILE');
    expect((await upload(owner, Buffer.alloc(0), 'vazio.png')).statusCode).toBe(400);
    expect(mediaFiles()).toHaveLength(3);
    expect(mediaFiles().some((f) => f.endsWith('.part'))).toBe(false);

    // edição
    expect((await waiter.fail('PATCH', `/api/tv/media/${imgBody.id}`, { title: 'x' })).status).toBe(403);
    const edited = await owner.ok('PATCH', `/api/tv/media/${imgBody.id}`, { title: '  Happy hour  ', durationSeconds: 15 });
    expect(edited).toMatchObject({ title: 'Happy hour', durationSeconds: 15, enabled: true });
    expect((await owner.fail('PATCH', `/api/tv/media/${imgBody.id}`, { durationSeconds: 1 })).code).toBe('VALIDATION');
    expect((await owner.fail('PATCH', `/api/tv/media/${imgBody.id}`, { durationSeconds: 9999 })).code).toBe('VALIDATION');
    await owner.ok('PATCH', `/api/tv/media/${vid.id}`, { enabled: false });

    // ordem: vídeo webm primeiro; os não citados mantêm a ordem relativa
    expect((await waiter.fail('PUT', '/api/tv/media/order', { ids: [webm.id] })).status).toBe(403);
    const ordered = await owner.ok<{ id: string }[]>('PUT', '/api/tv/media/order', { ids: [webm.id] });
    expect(ordered.map((m) => m.id)).toEqual([webm.id, imgBody.id, vid.id]);
    expect((await owner.fail('PUT', '/api/tv/media/order', { ids: ['0190f0a0-0000-7000-8000-000000000000'] })).status).toBe(404);

    // a TV recebe só os ativos, na ordem
    const board = env.s.tv.board();
    expect(board.media.map((m) => m.id)).toEqual([webm.id, imgBody.id]);
    expect(board.media[1]).toMatchObject({ kind: 'image', durationSeconds: 15, title: 'Happy hour' });

    // exclusão apaga o arquivo
    expect((await waiter.fail('DELETE', `/api/tv/media/${webm.id}`)).status).toBe(403);
    await owner.ok('DELETE', `/api/tv/media/${webm.id}`);
    expect(mediaFiles()).toHaveLength(2);
    expect((await owner.fail('DELETE', `/api/tv/media/${webm.id}`)).status).toBe(404);
    const list = await owner.ok<{ id: string }[]>('GET', '/api/tv/media');
    expect(list.map((m) => m.id)).toEqual([imgBody.id, vid.id]);
    expect(env.s.db.value("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'tv.media_%'")).toBeGreaterThanOrEqual(6);
  });

  it('vídeos grandes: aceita acima do limite padrão de 10 MB e recusa acima do limite da rota', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    // os demais envios continuam limitados a 10 MB
    const big = MP4(11 * 1024 * 1024);
    const ok = await upload(owner, big, 'video-longo.mp4');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().size).toBe(big.length);

    env.s.tvMedia.maxVideoBytes = 1024 * 1024;
    const tooBig = await upload(owner, MP4(2 * 1024 * 1024), 'enorme.mp4');
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe('FILE_TOO_LARGE');
    env.s.tvMedia.maxImageBytes = 1000;
    expect((await upload(owner, PNG(5000), 'foto-grande.png')).json().error.code).toBe('FILE_TOO_LARGE');
    expect(mediaFiles()).toHaveLength(1);
  });

  it('servidor HTTP real: envio em fluxo pela rede e vídeo lido por intervalos', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(env.app.server.address() as { port: number }).port}`;
    const bytes = MP4(12 * 1024 * 1024);
    const fd = new FormData();
    fd.append('file', new Blob([bytes]), 'abertura.mp4');
    const res = await fetch(`${base}/api/tv/media`, { method: 'POST', headers: { 'x-rupbar': '1', cookie: owner.cookie }, body: fd });
    expect(res.status).toBe(200);
    const media = (await res.json()) as { url: string; size: number };
    expect(media.size).toBe(bytes.length);
    const part = await fetch(`${base}${media.url}`, { headers: { cookie: owner.cookie, range: 'bytes=1048576-1048591' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(1048576, 1048592))).toBe(true);
  });

  it('reconhece formatos pela assinatura', () => {
    expect(sniffTvMedia(MP4())?.mime).toBe('video/mp4');
    expect(sniffTvMedia(WEBM())?.mime).toBe('video/webm');
    expect(sniffTvMedia(PNG())?.kind).toBe('image');
    expect(sniffTvMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))?.mime).toBe('image/jpeg');
    expect(sniffTvMedia(HEIC())).toBeNull();
    // Matroska genérico (sem DocType "webm") não é aceito
    expect(sniffTvMedia(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska', 'latin1')]))).toBeNull();
  });
});

describe('anúncios da TV: reprodução', () => {
  it('arquivo servido apenas para TV pareada e usuários logados, com Range (206), ETag e cache', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const bytes = MP4(4000);
    const vid = (await upload(owner, bytes, 'drinks.mp4')).json();
    const tv = await pairTv(owner);
    const board = await tv.ok('GET', '/api/tv/board');
    expect(board.media).toHaveLength(1);
    const url: string = board.media[0].url;
    expect(url).toMatch(new RegExp(`^/api/tv/media/${vid.id}/file\\?v=`));

    // anônimo não acessa
    const anon = new Client(env.app, '192.168.0.90');
    expect((await anon.req('GET', url)).statusCode).toBe(401);

    // TV pareada: arquivo inteiro
    const full = await tv.req('GET', url);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['cache-control']).toMatch(/private.*max-age=\d+/);
    expect(Number(full.headers['content-length'])).toBe(bytes.length);
    expect(full.rawPayload.equals(bytes)).toBe(true);
    const etag = String(full.headers.etag);
    expect(etag).toMatch(/^".+"$/);

    // intervalos
    const part = await tv.req('GET', url, undefined, { range: 'bytes=0-9' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-9/${bytes.length}`);
    expect(Number(part.headers['content-length'])).toBe(10);
    expect(part.rawPayload.equals(bytes.subarray(0, 10))).toBe(true);

    const open = await tv.req('GET', url, undefined, { range: 'bytes=100-' });
    expect(open.statusCode).toBe(206);
    expect(open.headers['content-range']).toBe(`bytes 100-${bytes.length - 1}/${bytes.length}`);
    expect(open.rawPayload.equals(bytes.subarray(100))).toBe(true);

    const suffix = await tv.req('GET', url, undefined, { range: 'bytes=-5' });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.equals(bytes.subarray(bytes.length - 5))).toBe(true);

    const beyond = await tv.req('GET', url, undefined, { range: `bytes=${bytes.length}-` });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers['content-range']).toBe(`bytes */${bytes.length}`);

    // If-Range com outra versão: arquivo inteiro; If-None-Match igual: 304
    expect((await tv.req('GET', url, undefined, { range: 'bytes=0-9', 'if-range': '"outra"' })).statusCode).toBe(200);
    expect((await tv.req('GET', url, undefined, { 'if-none-match': etag })).statusCode).toBe(304);

    // usuário logado (qualquer função) também pode pré-visualizar
    const waiter = await createStaff(env, owner, 'waiter', 'Wes', 'w@bar.com');
    expect((await waiter.req('GET', url, undefined, { range: 'bytes=0-0' })).statusCode).toBe(206);

    // arquivo apagado do disco: some da TV e responde 404 (a TV pula o item)
    unlinkSync(join(env.s.tvMedia.dir, readdirSync(env.s.tvMedia.dir)[0]!));
    expect((await tv.ok('GET', '/api/tv/board')).media).toHaveLength(0);
    expect((await owner.ok('GET', '/api/tv/media'))[0].missing).toBe(true);
    const gone = await tv.req('GET', url);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('MEDIA_MISSING');

    // TV desconectada perde o acesso
    const devices = await owner.ok('GET', '/api/tv/devices');
    await owner.ok('DELETE', `/api/tv/devices/${devices[0].id}`);
    expect((await tv.req('GET', url)).statusCode).toBe(401);
    expect(existsSync(env.s.tvMedia.dir)).toBe(true);
  });

  it('interpreta o cabeçalho Range', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=9-2', 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('exibição da TV (som e anúncios)', () => {
  it('valida, mescla, publica para a TV e tolera valores antigos inválidos', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const waiter = await createStaff(env, owner, 'waiter', 'Wes', 'w@bar.com');

    const defaults = await owner.ok('GET', '/api/tv/display');
    expect(defaults).toEqual({
      volume: 100, chimeRepeat: 2, callRepeat: 1, adsMode: 'off', boardSeconds: 20, adsSeconds: 30, boardAfterCallSeconds: 20,
      readyTicker: true, videoSound: false, videoVolume: 60, readyMinutes: 10, stations: ['kitchen'],
    });
    expect((await waiter.fail('GET', '/api/tv/display')).status).toBe(403);
    expect((await waiter.fail('PUT', '/api/tv/display', { volume: 10 })).status).toBe(403);

    const events: { type: string }[] = [];
    env.s.ctx.bus.subscribe((e) => e.channel === 'tv' && events.push(e));
    const saved = await owner.ok('PUT', '/api/tv/display', { adsMode: 'carousel', volume: 80, chimeRepeat: 3, videoSound: true, extra: 'ignorado' });
    expect(saved).toMatchObject({ adsMode: 'carousel', volume: 80, chimeRepeat: 3, videoSound: true, boardSeconds: 20 });
    expect(saved).not.toHaveProperty('extra');
    expect(events.map((e) => e.type)).toContain('tv.config');

    for (const bad of [{ volume: 150 }, { volume: -1 }, { adsMode: 'sempre' }, { boardSeconds: 2 }, { adsSeconds: 601 }, { chimeRepeat: 0 }, { callRepeat: 9 }, { videoSound: 'sim' }, { volume: 50.5 }]) {
      const e = await owner.fail('PUT', '/api/tv/display', bad);
      expect(e.status).toBe(400);
      expect(e.code).toBe('VALIDATION');
    }
    // inválidos não alteram o que foi salvo
    expect((await owner.ok('GET', '/api/tv/display')).volume).toBe(80);

    // a TV recebe a configuração junto com o painel
    const tv = await pairTv(owner);
    const board = await tv.ok('GET', '/api/tv/board');
    expect(board.display).toMatchObject({ adsMode: 'carousel', volume: 80, chimeRepeat: 3 });
    expect(board.media).toEqual([]);
    // a TV não altera configurações
    expect((await tv.fail('PUT', '/api/tv/display', { volume: 0 })).status).toBe(401);

    // valor gravado por versão antiga (fora da faixa) volta ao padrão sem perder os demais
    env.s.settings.setJson('tv_display', { volume: 999, adsMode: 'ads_first', boardAfterCallSeconds: 45 });
    expect(env.s.tv.display()).toMatchObject({ volume: 100, adsMode: 'ads_first', boardAfterCallSeconds: 45, chimeRepeat: 2 });
  });

  it('chamada de teste toca nas TVs sem criar pedido', async () => {
    env = await createEnv();
    const owner = await setupEstablishment(env);
    const waiter = await createStaff(env, owner, 'waiter', 'Wes', 'w@bar.com');
    const events: { type: string; data?: Record<string, unknown> }[] = [];
    env.s.ctx.bus.subscribe((e) => e.channel === 'tv' && events.push(e));
    expect((await waiter.fail('POST', '/api/tv/test-call')).status).toBe(403);
    const r = await owner.ok('POST', '/api/tv/test-call');
    expect(r.text).toContain('Teste de som');
    const call = events.find((e) => e.type === 'pickup.call');
    expect(call?.data).toMatchObject({ test: true, customerDisplayName: 'Teste de som', comandaDisplayNumber: null });
    expect(env.s.db.value('SELECT COUNT(*) FROM pickup_calls')).toBe(0);
  });
});
