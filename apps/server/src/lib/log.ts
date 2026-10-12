import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/**
 * Logger em arquivo JSON-lines com rotação por tamanho (5 arquivos × 5 MB),
 * adequado para rodar como serviço do Windows sem console.
 */
export function createLogger(opts: { dir?: string; level?: Level; console?: boolean; scope?: string } = {}): Logger {
  const level = opts.level ?? 'info';
  const file = opts.dir ? join(opts.dir, 'rupbar-server.log') : null;
  if (opts.dir && !existsSync(opts.dir)) mkdirSync(opts.dir, { recursive: true });
  const MAX = 5 * 1024 * 1024;
  const KEEP = 5;

  function rotate() {
    if (!file) return;
    try {
      if (!existsSync(file) || statSync(file).size < MAX) return;
      const last = `${file}.${KEEP}`;
      if (existsSync(last)) unlinkSync(last);
      for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      renameSync(file, `${file}.1`);
    } catch {
      /* rotação é best-effort */
    }
  }

  let writes = 0;
  function write(lvl: Level, scope: string | undefined, msg: string, data?: Record<string, unknown>) {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, scope, msg, ...data });
    if (opts.console !== false) (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
    if (file) {
      if (++writes % 200 === 0) rotate();
      try {
        appendFileSync(file, line + '\n');
      } catch {
        /* disco cheio etc. — não derruba o servidor */
      }
    }
  }

  const make = (scope?: string): Logger => ({
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d),
    child: (s) => make(scope ? `${scope}.${s}` : s),
  });
  return make(opts.scope);
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
