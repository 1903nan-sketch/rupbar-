/**
 * Adaptador fino sobre o SQLite embutido do Node (node:sqlite).
 *
 * Por que node:sqlite: não exige módulo nativo compilado, então o servidor é
 * distribuído como um único bundle JS + node.exe, sem dependências de build no
 * Windows do cliente. A API é síncrona (como better-sqlite3), o que torna as
 * transações simples e seguras: um único processo escreve no banco.
 *
 * Durabilidade: WAL + synchronous=FULL. Uma queda de energia não corrompe o
 * banco nem perde transações confirmadas (caixa, pagamentos, estoque).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined;
export type Row = Record<string, SqlValue>;

function normalize(params: SqlParam[]): SqlValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function normalizeNamed(params: Record<string, SqlParam>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  return out;
}

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = FULL');
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...normalize(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  runNamed(sql: string, params: Record<string, SqlParam>): { changes: number } {
    const r = this.stmt(sql).run(normalizeNamed(params));
    return { changes: Number(r.changes) };
  }

  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...normalize(params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...normalize(params)) as T[];
  }

  /** Valor escalar da primeira coluna da primeira linha. */
  value<T = SqlValue>(sql: string, ...params: SqlParam[]): T | undefined {
    const row = this.stmt(sql).get(...normalize(params)) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return Object.values(row)[0] as T;
  }

  /**
   * Executa `fn` em transação. Transações aninhadas viram SAVEPOINTs.
   * BEGIN IMMEDIATE adquire o lock de escrita no início, evitando deadlocks
   * entre leitores que tentam promover para escrita.
   */
  tx<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try {
        const result = fn();
        if (result instanceof Promise) throw new Error('Transações devem ser síncronas');
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* já revertida */
        }
        throw err;
      } finally {
        this.depth--;
      }
    }
    const name = `sp_${this.depth}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** Checkpoint do WAL e cópia consistente do banco (backup). */
  backupTo(destPath: string): void {
    this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.raw.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.cache.clear();
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    this.raw.close();
  }
}

export function bool(v: SqlValue | undefined): boolean {
  return v === 1 || v === 1n || v === '1';
}

export function json<T>(v: SqlValue | undefined, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
