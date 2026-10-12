// Gera dist/server.cjs (um único arquivo, sem node_modules) + dist/public (interface).
// O instalador do Windows empacota: node.exe + server.cjs + public/.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, '..', '..', 'package.json'), 'utf8'));
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(dist, 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'external',
  define: { 'process.env.RUPBAR_VERSION': JSON.stringify(pkg.version), 'import.meta.url': 'undefined' },
  logLevel: 'info',
});

const ui = join(root, '..', 'local-ui', 'dist');
if (existsSync(join(ui, 'index.html'))) {
  cpSync(ui, join(dist, 'public'), { recursive: true });
  console.log('interface copiada para dist/public');
} else {
  console.warn('AVISO: interface não compilada (pnpm --filter @rupbar/local-ui build)');
}
writeFileSync(join(dist, 'VERSION'), pkg.version);
