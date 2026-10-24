/**
 * Ponto de entrada do servidor local do RupBar.
 *
 * Executado como serviço do Windows pelo `rupbar-service.exe` (supervisor) ou
 * diretamente em desenvolvimento. Escuta em todas as interfaces para que
 * celulares, tablets e a TV da rede local possam se conectar.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './http/app';
import { createLogger, type Level } from './lib/log';
import { createServices } from './services';

const VERSION = process.env.RUPBAR_VERSION ?? '0.5.1';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function defaultDataDir(): string {
  if (process.platform === 'win32') return join(process.env.ProgramData ?? 'C:\\ProgramData', 'RupBar');
  return join(process.env.HOME ?? '.', '.rupbar');
}

/** Pasta do server.cjs (instalado) ou de src/ (desenvolvimento). */
function serverDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function defaultUiDir(): string | null {
  const here = serverDir();
  for (const candidate of [join(here, 'public'), join(here, '..', 'public'), resolve(here, '../../local-ui/dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/** Downloads oferecidos aos celulares (instalado: <app>/server/downloads; dev: apps/android/dist). */
function defaultDownloadsDir(): string | null {
  const here = serverDir();
  for (const candidate of [join(here, 'downloads'), join(here, '..', 'downloads'), resolve(here, '../../android/dist')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  // node:sqlite é estável o suficiente para produção, mas ainda emite aviso experimental.
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name !== 'ExperimentalWarning') console.warn(w);
  });

  const dataDir = resolve(arg('data-dir') ?? process.env.RUPBAR_DATA_DIR ?? defaultDataDir());
  const port = Number(arg('port') ?? process.env.RUPBAR_PORT ?? 7420);
  const host = arg('host') ?? process.env.RUPBAR_HOST ?? '0.0.0.0';
  const log = createLogger({ dir: join(dataDir, 'logs'), level: (process.env.RUPBAR_LOG_LEVEL as Level) ?? 'info', console: process.stdout.isTTY ?? false });

  const services = createServices({
    config: {
      dataDir,
      attachmentsDir: join(dataDir, 'attachments'),
      logsDir: join(dataDir, 'logs'),
      backupsDir: join(dataDir, 'backups'),
      port,
      uiDir: arg('ui-dir') ?? process.env.RUPBAR_UI_DIR ?? defaultUiDir(),
      downloadsDir: arg('downloads-dir') ?? process.env.RUPBAR_DOWNLOADS_DIR ?? defaultDownloadsDir(),
      version: VERSION,
    },
    log,
  });

  const app = await buildApp(services);
  services.startWorkers();
  await app.listen({ port, host });
  log.info('RupBar Server iniciado', { port, dataDir, version: VERSION, ui: services.ctx.config.uiDir });

  // Backup diário automático (mantém os 14 mais recentes).
  const backupTimer = setInterval(() => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const file = join(services.ctx.config.backupsDir, `auto-${day}.db`);
      if (!existsSync(file)) {
        services.db.backupTo(file);
        log.info('backup automático criado', { file });
      }
    } catch (err) {
      log.error('falha no backup automático', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 60 * 60_000);
  backupTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('encerrando', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    try {
      await app.close();
      services.close();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // O supervisor do Windows envia "shutdown" pelo stdin (sinais POSIX não existem lá).
  process.stdin.on('data', (d) => {
    if (String(d).trim() === 'shutdown') void shutdown('stdin');
  });
  process.on('uncaughtException', (err) => {
    log.error('exceção não tratada', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (err) => {
    log.error('promessa rejeitada', { error: err instanceof Error ? err.message : String(err) });
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
