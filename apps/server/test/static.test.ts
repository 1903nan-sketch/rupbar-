import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createEnv, type TestEnv } from './helpers';

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.app.close();
  env?.s.close();
});

it('interface depois de atualizar: página sempre conferida, arquivo com hash fixo, arquivo antigo é 404', async () => {
  const ui = mkdtempSync(join(tmpdir(), 'rupbar-ui-'));
  mkdirSync(join(ui, 'assets'));
  writeFileSync(join(ui, 'index.html'), '<!doctype html><script type="module" crossorigin src="/assets/index-NOVO.js"></script>');
  writeFileSync(join(ui, 'assets', 'index-NOVO.js'), 'console.log(1)');
  writeFileSync(join(ui, 'sw.js'), '');
  const dataDir = mkdtempSync(join(tmpdir(), 'rupbar-static-'));
  env = await createEnv({
    config: { dataDir, attachmentsDir: join(dataDir, 'a'), logsDir: join(dataDir, 'l'), backupsDir: join(dataDir, 'b'), port: 7420, uiDir: ui, version: 'test' },
  });
  const get = (url: string) => env!.app.inject({ method: 'GET', url });
  expect((await get('/')).headers['cache-control']).toBe('no-cache');
  expect((await get('/relatorios')).headers['cache-control']).toBe('no-cache');
  expect((await get('/sw.js')).headers['cache-control']).toBe('no-cache');
  expect((await get('/assets/index-NOVO.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
  // A tela antiga pede um arquivo que a atualização apagou: 404 (e não a página no lugar do arquivo).
  const old = await get('/assets/Losses-ANTIGO.js');
  expect(old.statusCode).toBe(404);
  expect(old.headers['content-type']).not.toContain('text/html');
});
