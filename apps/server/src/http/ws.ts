import type { Permission } from '@rupbar/core';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Channel, RealtimeEvent } from '../lib/events';
import type { Services } from '../services';
import { tokenFrom, tvTokenFrom } from './app';

/** Permissão necessária para receber eventos de cada canal. */
const CHANNEL_PERMISSION: Record<Channel, Permission | null> = {
  comandas: 'comandas.view',
  kitchen: 'kitchen.view',
  tv: 'kitchen.view',
  stock: 'stock.view',
  cash: 'cash.view',
  hookah: 'hookah.view',
  printing: 'kitchen.view',
  sync: null,
  system: null,
};

interface Client {
  socket: WebSocket;
  kind: 'user' | 'tv';
  userId: string | null;
  token: string;
  channels: Set<Channel>;
  alive: boolean;
}

/**
 * Canal de tempo real pela rede local. Os eventos são apenas avisos ("algo
 * mudou"); os dados são sempre buscados pela API, que aplica as permissões.
 */
export function registerWebsocket(app: FastifyInstance, s: Services) {
  const clients = new Set<Client>();

  app.get('/ws', { websocket: true }, (socket, req) => {
    const session = req.session;
    const tv = req.tv;
    if (!session && !tv) {
      socket.close(4401, 'unauthenticated');
      return;
    }
    let channels: Set<Channel>;
    if (session) {
      channels = new Set(
        (Object.entries(CHANNEL_PERMISSION) as [Channel, Permission | null][])
          .filter(([, perm]) => perm === null || session.actor.permissions.has(perm))
          .map(([c]) => c),
      );
    } else {
      channels = new Set<Channel>(['tv']);
    }
    const client: Client = {
      socket,
      kind: session ? 'user' : 'tv',
      userId: session?.user.id ?? null,
      token: (session ? tokenFrom(req) : tvTokenFrom(req)) ?? '',
      channels,
      alive: true,
    };
    clients.add(client);
    socket.send(JSON.stringify({ channel: 'system', type: 'hello', data: { channels: [...channels], serverTime: s.ctx.nowIso() } }));
    socket.on('pong', () => (client.alive = true));
    socket.on('message', (raw) => {
      // Mensagens do cliente: apenas "ping" de aplicação.
      if (String(raw) === 'ping') socket.send('pong');
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  const unsubscribe = s.ctx.bus.subscribe((event: RealtimeEvent) => {
    const msg = JSON.stringify(event);
    for (const c of clients) {
      if (event.type === 'session.revoked' && c.userId && c.userId === event.data?.userId) {
        c.socket.close(4401, 'session revoked');
        continue;
      }
      if (event.type === 'device.revoked' && c.kind === 'tv') {
        // A TV revalida seu token; se revogado, a conexão é encerrada abaixo.
        if (!s.tv.resolve(c.token)) c.socket.close(4401, 'device revoked');
        continue;
      }
      if (!c.channels.has(event.channel)) continue;
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(msg);
    }
  });

  // Batimento: derruba conexões mortas e revalida sessões a cada 30 s.
  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.socket.terminate();
        clients.delete(c);
        continue;
      }
      const valid = c.kind === 'user' ? !!s.auth.resolve(c.token) : !!s.tv.resolve(c.token);
      if (!valid) {
        c.socket.close(4401, 'session expired');
        clients.delete(c);
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }, 30_000);
  timer.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    unsubscribe();
    for (const c of clients) c.socket.close(1001, 'server shutdown');
  });

  return { count: () => clients.size };
}
