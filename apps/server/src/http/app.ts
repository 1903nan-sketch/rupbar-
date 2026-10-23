import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import type { SessionInfo } from '../services/auth';
import type { Actor } from '../services/context';
import type { Services } from '../services';
import type { TvDevice } from '../services/tv';
import { registerRoutes } from './routes';
import { registerWebsocket } from './ws';

export const SESSION_COOKIE = 'rupbar_session';
export const TV_COOKIE = 'rupbar_tv';
const SESSION_MAX_AGE = 30 * 24 * 3600;

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
    tv: TvDevice | null;
  }
}

/** Rotas acessíveis enquanto a troca obrigatória de senha está pendente. */
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout', '/api/branding']);

export function isLoopback(ip: string | undefined): boolean {
  return !!ip && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
}

export function tokenFrom(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.cookies[SESSION_COOKIE] ?? null;
}

export function tvTokenFrom(req: FastifyRequest): string | null {
  const h = req.headers['x-rupbar-tv'];
  if (typeof h === 'string' && h) return h;
  return req.cookies[TV_COOKIE] ?? null;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_MAX_AGE });
}

/** Ator autenticado (usuário). Lança 401/403 conforme o caso. */
export function actorOf(req: FastifyRequest): Actor {
  const s = req.session;
  if (!s) throw unauthorized();
  if (s.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.routeOptions.url ?? '')) {
    throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Troque sua senha temporária para continuar.');
  }
  return s.actor;
}

/** Limitador simples em memória (por IP) para login e pareamento. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  check(key: string): void {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) throw new AppError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde alguns minutos.');
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
  }
}

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(services: Services, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorateRequest('session', null);
  app.decorateRequest('tv', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) return;
    const meta = { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
    req.session = services.auth.resolve(tokenFrom(req), meta);
    const tvToken = tvTokenFrom(req);
    if (tvToken) req.tv = services.tv.resolve(tvToken, req.ip);
    // Proteção CSRF: toda requisição que altera estado precisa do cabeçalho
    // customizado, que navegadores só enviam a partir da mesma origem.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && req.url.startsWith('/api')) {
      if (req.headers['x-rupbar'] !== '1') throw forbidden('Requisição sem cabeçalho de segurança.', 'CSRF');
    }
  });

  // Scripts embutidos no index.html (detecção da versão para navegadores antigos
  // de TV box/celular) entram na CSP pelo hash — nenhum outro script inline roda.
  const inlineHashes = inlineScriptHashes(services.ctx.config.uiDir);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (!req.url.startsWith('/api')) {
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'${inlineHashes}; ` +
          `connect-src 'self' ws: http://*:${services.ctx.config.port}; media-src 'self' blob: data:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'`,
      );
    } else if (!reply.hasHeader('Cache-Control')) {
      // Respostas da API não ficam em cache, exceto quando a rota define a política (arquivos, mídia da TV).
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.status(400).send({
        error: { code: 'VALIDATION', message: issues[0] ? `${issues[0].message}${issues[0].path ? ` (${issues[0].path})` : ''}` : 'Dados inválidos.', details: issues },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      const message = e.code === 'FST_REQ_FILE_TOO_LARGE' ? 'Arquivo muito grande.' : 'Requisição inválida.';
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message } });
    }
    const sqlite = /UNIQUE constraint failed/.test(e.message ?? '');
    if (sqlite) return reply.status(409).send({ error: { code: 'DUPLICATE', message: 'Registro duplicado.' } });
    services.ctx.log.error('erro não tratado', { url: req.url, method: req.method, error: e.message, stack: (err as Error).stack });
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Erro interno. A operação não foi concluída.' } });
  });

  const hub = registerWebsocket(app, services);
  registerRoutes(app, services, hub);

  const uiDir = services.ctx.config.uiDir;
  if (uiDir && existsSync(join(uiDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: uiDir, prefix: '/', wildcard: false, index: ['index.html'], cacheControl: false,
      // index.html sempre conferido (depois de uma atualização a tela antiga pedia arquivos que
      // não existem mais e travava); /assets tem o hash no nome e nunca muda.
      setHeaders: (reply, path) => {
        const name = path.replace(/\\/g, '/');
        reply.header('Cache-Control', name.endsWith('/index.html') || name.endsWith('/sw.js') ? 'no-cache' : name.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      },
    });
    // SPA: rotas desconhecidas fora de /api servem o index.html; arquivo que não existe é 404.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]!;
      if (path.startsWith('/api') || path.startsWith('/ws') || path.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(path)) {
        return reply.status(404).header('Cache-Control', 'no-store').send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }));
  }

  return app;
}

/** Hashes CSP ('sha256-…') dos <script> sem src do index.html da interface. */
export function inlineScriptHashes(uiDir: string | null | undefined): string {
  if (!uiDir || !existsSync(join(uiDir, 'index.html'))) return '';
  const html = readFileSync(join(uiDir, 'index.html'), 'utf8');
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1]) continue;
    hashes.add(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return hashes.size ? ' ' + [...hashes].join(' ') : '';
}
