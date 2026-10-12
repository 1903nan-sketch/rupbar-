import { EventEmitter } from 'node:events';

/**
 * Eventos de tempo real. Cada evento tem um canal; clientes WebSocket assinam
 * canais conforme suas permissões (a TV só recebe "tv").
 */
export type Channel = 'comandas' | 'kitchen' | 'tv' | 'stock' | 'cash' | 'sync' | 'system' | 'hookah' | 'printing';

export interface RealtimeEvent {
  channel: Channel;
  type: string;
  data?: Record<string, unknown>;
}

export class EventBus {
  private emitter = new EventEmitter();
  private pending: RealtimeEvent[] = [];

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  /**
   * Publica após a transação atual (o chamador agenda via queue + flush).
   * Publicar dentro da transação poderia anunciar dados que ainda serão revertidos.
   */
  queue(event: RealtimeEvent): void {
    this.pending.push(event);
  }

  flush(): void {
    const events = this.pending;
    this.pending = [];
    for (const e of events) this.emitter.emit('event', e);
  }

  discard(): void {
    this.pending = [];
  }

  publish(event: RealtimeEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(fn: (e: RealtimeEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
