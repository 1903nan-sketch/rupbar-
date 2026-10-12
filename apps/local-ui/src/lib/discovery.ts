/**
 * Reencontra o PC do bar quando o endereço muda (ex.: roteador reiniciado).
 *
 * O aplicativo fica em cache no celular (service worker). Se o endereço antigo
 * não responder, testamos: rupbar.local (mDNS), endereços já conhecidos e, por
 * fim, a sub-rede local (x.y.z.1–254) na porta do RupBar. Encontrado o servidor
 * do MESMO estabelecimento, redirecionamos para o novo endereço.
 */

const KEY = 'rupbar.server';

interface Known {
  origins: string[];
  establishmentId: string | null;
  port: number;
}

function load(): Known {
  try {
    return { origins: [], establishmentId: null, port: 7420, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { origins: [], establishmentId: null, port: 7420 };
  }
}

export function rememberServer(establishmentId: string | null, port: number): void {
  try {
    const k = load();
    const origins = [location.origin, ...k.origins.filter((o) => o !== location.origin)].slice(0, 5);
    localStorage.setItem(KEY, JSON.stringify({ origins, establishmentId: establishmentId ?? k.establishmentId, port }));
  } catch {
    /* armazenamento indisponível */
  }
}

async function probe(origin: string, establishmentId: string | null, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(`${origin}/api/discovery`, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = (await r.json()) as { app?: string; establishmentId?: string | null };
    return j.app === 'rupbar' && (!establishmentId || !j.establishmentId || j.establishmentId === establishmentId);
  } catch {
    return false;
  }
}

export async function findServer(onProgress?: (msg: string) => void): Promise<string | null> {
  const k = load();
  const port = k.port || Number(location.port) || 7420;
  const candidates = [location.origin, `http://rupbar.local:${port}`, ...k.origins].filter((v, i, a) => a.indexOf(v) === i);
  onProgress?.('Tentando endereços conhecidos…');
  for (const c of candidates) if (await probe(c, k.establishmentId, 2000)) return c;

  const last = [location.hostname, ...k.origins.map((o) => new URL(o).hostname)].find((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h));
  if (!last) return null;
  const prefix = last.split('.').slice(0, 3).join('.');
  onProgress?.(`Procurando na rede ${prefix}.x…`);
  const hosts = Array.from({ length: 254 }, (_, i) => `http://${prefix}.${i + 1}:${port}`);
  for (let i = 0; i < hosts.length; i += 32) {
    const batch = hosts.slice(i, i + 32);
    const found = await Promise.all(batch.map(async (h) => ((await probe(h, k.establishmentId, 900)) ? h : null)));
    const hit = found.find(Boolean);
    if (hit) return hit;
  }
  return null;
}
