// Prepara os recursos empacotados no instalador:
//   src-tauri/resources/server/{node.exe, server.cjs, public/}
//   src-tauri/resources/rupbar-service.exe
// Requer: interface compilada, servidor empacotado e supervisor compilado (CI).
import { createWriteStream, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const res = join(here, '../src-tauri/resources');
const serverOut = join(res, 'server');
const NODE_VERSION = process.env.RUPBAR_NODE_VERSION ?? '22.22.0';

rmSync(res, { recursive: true, force: true });
mkdirSync(serverOut, { recursive: true });

const bundle = join(repo, 'apps/server/dist');
if (!existsSync(join(bundle, 'server.cjs'))) throw new Error('Rode antes: pnpm bundle:server');
cpSync(join(bundle, 'server.cjs'), join(serverOut, 'server.cjs'));
if (existsSync(join(bundle, 'public'))) cpSync(join(bundle, 'public'), join(serverOut, 'public'), { recursive: true });
else throw new Error('Interface ausente em apps/server/dist/public');

const svcCandidates = [
  join(repo, 'apps/service-host/target/x86_64-pc-windows-msvc/release/rupbar-service.exe'),
  join(repo, 'apps/service-host/target/release/rupbar-service.exe'),
];
const svc = svcCandidates.find(existsSync);
if (!svc) throw new Error('rupbar-service.exe não encontrado (cargo build --release em apps/service-host)');
cpSync(svc, join(res, 'rupbar-service.exe'));

// Node.js oficial para Windows (somente o executável), verificado por SHA-256.
const nodeExe = join(serverOut, 'node.exe');
const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const url = `${base}/win-x64/node.exe`;
console.log('baixando', url);
const r = await fetch(url);
if (!r.ok) throw new Error(`download do Node falhou: ${r.status}`);
await pipeline(r.body, createWriteStream(nodeExe));
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const expected = sums.split('\n').find((l) => l.endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const actual = createHash('sha256').update(readFileSync(nodeExe)).digest('hex');
if (!expected || expected !== actual) throw new Error('SHA-256 do node.exe não confere');
console.log('recursos prontos em', res);
