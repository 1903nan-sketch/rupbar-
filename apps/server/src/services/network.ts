import { networkInterfaces } from 'node:os';
import type { Ctx } from './context';

export interface LanAddress {
  ip: string;
  iface: string;
  mac: string;
  netmask: string;
  score: number;
}

const VIRTUAL = /(vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|hamachi|vpn|tap|tun|br-|veth|utun|bluetooth)/i;

export function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b! >= 16 && b! <= 31);
}

/** Endereços IPv4 da rede local, do mais provável (Wi-Fi/Ethernet do bar) ao menos. */
export function lanAddresses(ifaces = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateIPv4(a.address)) continue;
      let score = 0;
      if (VIRTUAL.test(name)) score -= 100;
      if (/wi-?fi|wlan|wireless|ethernet|eth|en\d|lan/i.test(name)) score += 20;
      if (a.address.startsWith('192.168.')) score += 10;
      if (a.address.startsWith('10.')) score += 5;
      out.push({ ip: a.address, iface: name, mac: a.mac, netmask: a.netmask, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * Rede local: endereço preferencial, anúncio mDNS (rupbar.local) e detecção de
 * mudança de IP (ex.: roteador reiniciado sem reserva de IP).
 */
export class NetworkService {
  private current: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private mdns: { destroy(): void } | null = null;
  readonly hostname = 'rupbar.local';

  constructor(private readonly ctx: Ctx) {}

  preferred(): LanAddress | null {
    return lanAddresses()[0] ?? null;
  }

  info() {
    const all = lanAddresses();
    const port = this.ctx.config.port;
    const ip = all[0]?.ip ?? null;
    return {
      port,
      ip,
      url: ip ? `http://${ip}:${port}` : `http://localhost:${port}`,
      mdnsUrl: `http://${this.hostname}:${port}`,
      mdnsActive: !!this.mdns,
      addresses: all.map((a) => ({ ip: a.ip, iface: a.iface, mac: a.mac })),
      previousIp: this.ctx.meta('network_previous_ip'),
      changedAt: this.ctx.meta('network_changed_at'),
    };
  }

  start(intervalMs = 15_000): void {
    this.current = this.preferred()?.ip ?? null;
    const known = this.ctx.meta('network_last_ip');
    if (known && this.current && known !== this.current) this.recordChange(known, this.current);
    if (this.current) this.ctx.setMeta('network_last_ip', this.current);
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
    void this.startMdns();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.mdns?.destroy();
    this.mdns = null;
  }

  check(): void {
    const ip = this.preferred()?.ip ?? null;
    if (ip && ip !== this.current) {
      const prev = this.current;
      this.current = ip;
      this.ctx.setMeta('network_last_ip', ip);
      if (prev) this.recordChange(prev, ip);
    }
  }

  private recordChange(prev: string, ip: string) {
    this.ctx.setMeta('network_previous_ip', prev);
    this.ctx.setMeta('network_changed_at', this.ctx.nowIso());
    this.ctx.log.warn('endereço de rede mudou', { from: prev, to: ip });
    this.ctx.bus.publish({ channel: 'system', type: 'network.changed', data: { previousIp: prev, ip, url: `http://${ip}:${this.ctx.config.port}` } });
  }

  /** Responde consultas mDNS por rupbar.local com o IP atual. */
  private async startMdns() {
    try {
      const { default: makeMdns } = await import('multicast-dns');
      const mdns = makeMdns();
      mdns.on('query', (query) => {
        const ip = this.current;
        if (!ip) return;
        for (const q of query.questions) {
          if (q.name.toLowerCase() === this.hostname && (q.type === 'A' || (q.type as string) === 'ANY')) {
            mdns.respond({ answers: [{ name: this.hostname, type: 'A', ttl: 120, data: ip }] });
          }
        }
      });
      mdns.on('error', (err: Error) => this.ctx.log.warn('mDNS indisponível', { error: err.message }));
      this.mdns = mdns;
    } catch (err) {
      this.ctx.log.warn('mDNS não iniciado', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
