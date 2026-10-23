import { RefreshCw } from 'lucide-react';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Card, Empty } from '../components/ui';

/*
 * Depois de instalar uma versão nova no PC, uma tela já aberta continuava na
 * versão antiga: pedia arquivos que não existem mais (Perdas e Relatórios
 * travavam) e escondia o que é novo. Aqui a tela percebe e recarrega.
 */

const RELOAD_KEY = 'rupbar_reload_at';

/** Recarrega a página uma vez (sem laço: no máximo a cada 20 s). */
export function reloadForUpdate(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) < 20_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Sem sessionStorage: recarrega mesmo assim.
  }
  window.location.reload();
  return true;
}

/** Erro de arquivo da tela que não carregou (versão antiga pedindo arquivo que sumiu). */
export function isChunkError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch|ChunkLoadError|Loading chunk|MIME type|Unable to preload/i.test(m);
}

const entryOf = (html: string) => /<script type="module" crossorigin src="(\/assets\/index-[^"]+)"/.exec(html)?.[1] ?? null;
/** Arquivo principal da tela que está aberta (só no build de produção). */
const bootEntry = typeof document !== 'undefined'
  ? document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') ?? null
  : null;

/** O PC já tem uma versão da tela diferente da que está aberta? */
export async function newBuildAvailable(): Promise<boolean> {
  if (!bootEntry) return false;
  try {
    const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
    const entry = res.ok ? entryOf(await res.text()) : null;
    return !!entry && entry !== bootEntry;
  } catch {
    return false;
  }
}

/**
 * Confere de tempos em tempos (e ao voltar para a janela) se o RupBar foi
 * atualizado. Havendo versão nova: a TV recarrega na hora; nas outras telas
 * aparece um aviso e a próxima troca de tela já abre a versão nova.
 */
export function UpdateWatcher() {
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      if (stop || pending || document.visibilityState === 'hidden') return;
      if (await newBuildAvailable()) {
        if (location.pathname.startsWith('/tv')) window.location.reload();
        else setPending(true);
      }
    };
    const t = window.setInterval(() => void check(), 3 * 60_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const boot = window.setTimeout(() => void check(), 8_000);
    return () => {
      stop = true;
      window.clearInterval(t);
      window.clearTimeout(boot);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [location.pathname, pending]);
  // Trocou de tela com versão nova esperando: abre já na versão nova.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (pending) window.location.reload();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pending) return null;
  return (
    <div className="update-banner" role="status">
      <span>O RupBar foi atualizado.</span>
      <Button size="small" variant="primary" icon={<RefreshCw size={14} />} onClick={() => window.location.reload()}>Recarregar</Button>
    </div>
  );
}

/** Tela que não abriu: recarrega sozinha se for arquivo de versão antiga; senão, explica. */
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown) {
    if (isChunkError(error)) reloadForUpdate();
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Card>
        <Empty icon={<RefreshCw size={36} />} title="Não foi possível abrir esta tela">
          {isChunkError(this.state.error) ? 'O RupBar foi atualizado. Recarregue para abrir a versão nova.' : 'Recarregue a tela. Se continuar, reinicie o RupBar.'}
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => window.location.reload()}>Recarregar</Button>
          </div>
        </Empty>
      </Card>
    );
  }
}
