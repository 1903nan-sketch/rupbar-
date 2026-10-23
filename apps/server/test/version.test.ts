import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..', '..');
const json = (p: string) => JSON.parse(readFileSync(join(repo, p), 'utf8')) as { version: string };
const toml = (p: string) => /^version = "([^"]+)"/m.exec(readFileSync(join(repo, p), 'utf8'))![1];

describe('versão do RupBar', () => {
  // O servidor do PC informa à nuvem a versão do package.json da raiz (scripts/bundle.mjs);
  // o painel usa esse número. Todas as peças precisam andar juntas.
  it('é a mesma no servidor, na interface, no instalador e nos serviços do Windows', () => {
    const root = json('package.json').version;
    expect(json('apps/server/package.json').version).toBe(root);
    expect(json('apps/local-ui/package.json').version).toBe(root);
    expect(json('apps/desktop/package.json').version).toBe(root);
    expect(json('apps/desktop/src-tauri/tauri.conf.json').version).toBe(root);
    expect(toml('apps/desktop/src-tauri/Cargo.toml')).toBe(root);
    expect(toml('apps/service-host/Cargo.toml')).toBe(root);
    expect(readFileSync(join(repo, 'apps/server/src/main.ts'), 'utf8')).toContain(`RUPBAR_VERSION ?? '${root}'`);
  });

  it('é nova o bastante para as ações do painel online', () => {
    const min = /OWNER_ACTIONS_VERSION = '([^']+)'/.exec(readFileSync(join(repo, 'apps/owner-panel/lib/data.ts'), 'utf8'))![1]!;
    const n = (v: string) => v.split('.').map(Number);
    const [a, b] = [n(json('package.json').version), n(min)];
    expect(a[0]! * 1e6 + a[1]! * 1e3 + a[2]!).toBeGreaterThanOrEqual(b[0]! * 1e6 + b[1]! * 1e3 + b[2]!);
  });
});
