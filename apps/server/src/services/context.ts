import { uuidv7, type Permission } from '@rupbar/core';
import type { Db } from '../db/db';
import type { SecretBox } from '../lib/crypto';
import { forbidden } from '../lib/errors';
import type { EventBus, RealtimeEvent } from '../lib/events';
import type { Logger } from '../lib/log';
import type { Clock } from '../lib/time';

export interface ServerConfig {
  dataDir: string;
  attachmentsDir: string;
  logsDir: string;
  backupsDir: string;
  port: number;
  /** Diretório com a interface compilada (servida para PC, celulares e TV). */
  uiDir: string | null;
  /**
   * Arquivos que o PC oferece para download na rede local (ex.: o app Android do
   * garçom, rupbar-garcom.apk, empacotado no instalador). Também é consultada a
   * pasta `<dataDir>/downloads`.
   */
  downloadsDir?: string | null;
  version: string;
}

/** Quem está executando uma ação (para permissões e auditoria). */
export interface Actor {
  kind: 'user' | 'system' | 'remote' | 'tv';
  userId: string | null;
  name: string;
  roleKey: string | null;
  permissions: ReadonlySet<Permission>;
  ip?: string | null;
  sessionId?: string | null;
}

export const SYSTEM_ACTOR: Actor = {
  kind: 'system',
  userId: null,
  name: 'Sistema',
  roleKey: null,
  permissions: new Set<Permission>(),
};

export function requirePerm(actor: Actor, ...perms: Permission[]): void {
  if (actor.kind === 'system') return;
  for (const p of perms) if (!actor.permissions.has(p)) throw forbidden();
}

export function hasPerm(actor: Actor, perm: Permission): boolean {
  return actor.kind === 'system' || actor.permissions.has(perm);
}

export class Ctx {
  constructor(
    readonly db: Db,
    readonly bus: EventBus,
    readonly clock: Clock,
    readonly log: Logger,
    readonly config: ServerConfig,
    readonly secrets: SecretBox,
  ) {}

  nowIso(): string {
    return this.clock.now().toISOString();
  }

  id(): string {
    return uuidv7(this.clock.now().getTime());
  }

  /**
   * Transação com publicação de eventos de tempo real apenas após o COMMIT.
   */
  tx<T>(fn: () => T): T {
    const outer = !this.db.inTransaction;
    try {
      const r = this.db.tx(fn);
      if (outer) this.bus.flush();
      return r;
    } catch (err) {
      if (outer) this.bus.discard();
      throw err;
    }
  }

  emit(event: RealtimeEvent): void {
    if (this.db.inTransaction) this.bus.queue(event);
    else this.bus.publish(event);
  }

  /** Próximo valor de uma sequência (numeração de comandas, pedidos, caixas). */
  nextSeq(name: string): number {
    this.db.run('INSERT INTO sequences(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', name);
    return this.db.value<number>('SELECT value FROM sequences WHERE name = ?', name)!;
  }

  meta(key: string): string | null {
    return this.db.value<string>('SELECT value FROM meta WHERE key = ?', key) ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.run('DELETE FROM meta WHERE key = ?', key);
    else this.db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  audit(actor: Actor, action: string, entity: string | null, entityId: string | null, data?: Record<string, unknown>): void {
    this.db.run(
      'INSERT INTO audit_log (id, user_id, user_name, action, entity, entity_id, data_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      this.id(),
      actor.userId,
      actor.name,
      action,
      entity,
      entityId,
      data ? JSON.stringify(data) : null,
      actor.ip ?? null,
      this.nowIso(),
    );
  }
}
