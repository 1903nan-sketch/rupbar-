/*
 * Service worker do RupBar: guarda a interface (HTML/JS/CSS) no aparelho para
 * que ela abra mesmo quando o endereço do PC mudar e possa reencontrá-lo.
 * Dados (/api) e tempo real (/ws) NUNCA são guardados em cache.
 *
 * v2: a página é sempre conferida com o PC (sem o cache do navegador) e só
 * resposta boa entra no cache — antes, depois de uma atualização, a tela antiga
 * ficava e as telas novas (Perdas, Relatórios) travavam.
 */
const CACHE = 'rupbar-shell-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([new Request('/', { cache: 'no-cache' }), '/icon.svg', '/manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (e.request.mode === 'navigate') {
    // Rede primeiro (sem o cache do navegador); sem rede, a última versão da interface.
    e.respondWith(
      fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Arquivos versionados pelo build: cache primeiro. Só guarda arquivo de verdade
    // (nunca um erro ou uma página no lugar do arquivo).
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          }),
      ),
    );
  }
});
