/**
 * Conexão WebSocket com o PC do bar. Reconecta automaticamente com backoff e
 * avisa quando a conexão cai (a interface mostra "Reconectando...").
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface RealtimeEvent {
  channel: string;
  type: string;
  data?: Record<string, any>;
}

type Handler = (e: RealtimeEvent) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusListeners = new Set<() => void>();
  private attempt = 0;
  private timer: number | null = null;
  private wanted = false;
  status: 'connecting' | 'online' | 'offline' = 'offline';

  connect() {
    this.wanted = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('online');
    };
    ws.onmessage = (m) => {
      if (m.data === 'pong') return;
      try {
        const e = JSON.parse(String(m.data)) as RealtimeEvent;
        this.handlers.forEach((h) => h(e));
      } catch {
        /* ignora */
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      this.setStatus('offline');
      if (ev.code === 4401) this.handlers.forEach((h) => h({ channel: 'system', type: 'unauthorized' }));
      if (!this.wanted) return;
      const delay = Math.min(15_000, 500 * 2 ** this.attempt++) + Math.random() * 500;
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  disconnect() {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000);
    this.ws = null;
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  private setStatus(s: Realtime['status']) {
    this.status = s;
    this.statusListeners.forEach((l) => l());
    if (s === 'online') this.handlers.forEach((h) => h({ channel: 'system', type: 'reconnected' }));
  }

  subscribe(h: Handler) {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  onStatus(l: () => void) {
    this.statusListeners.add(l);
    return () => {
      this.statusListeners.delete(l);
    };
  }
}

export const realtime = new Realtime();

/**
 * Executa `fn` quando chegar um evento do canal (ou do tipo) informado.
 * Também dispara ao reconectar, para recarregar dados possivelmente perdidos.
 */
export function useRealtime(match: string | string[], fn: (e: RealtimeEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const key = Array.isArray(match) ? match.join(',') : match;
  useEffect(() => {
    const list = key.split(',');
    return realtime.subscribe((e) => {
      if (e.type === 'reconnected' || list.includes(e.channel) || list.includes(e.type)) ref.current(e);
    });
  }, [key]);
}

export function useRealtimeStatus() {
  return useSyncExternalStore(
    (cb) => realtime.onStatus(cb),
    () => realtime.status,
  );
}
