import { useCallback, useEffect, useState } from 'react';

/** Variantes com prefixo (WebKit) ainda usadas por navegadores de Smart TV. */
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const fsDoc = () => document as FsDocument;
const currentFullscreen = () => !!(fsDoc().fullscreenElement ?? fsDoc().webkitFullscreenElement);

export function fullscreenSupported(): boolean {
  const d = fsDoc();
  const el = document.documentElement as FsElement;
  return !!(d.fullscreenEnabled ?? d.webkitFullscreenEnabled) && !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

/**
 * Tela cheia pela Fullscreen API. `toggle` precisa ser chamado dentro de um
 * gesto do usuário (toque, clique ou OK no controle).
 */
export function useFullscreen() {
  const [on, setOn] = useState(currentFullscreen);
  useEffect(() => {
    const sync = () => setOn(currentFullscreen());
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const enter = useCallback(async () => {
    if (currentFullscreen()) return true;
    const el = document.documentElement as FsElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else await el.webkitRequestFullscreen?.();
      return true;
    } catch {
      return false; // recusado pelo navegador
    }
  }, []);

  const toggle = useCallback(async () => {
    if (!currentFullscreen()) return enter();
    try {
      const d = fsDoc();
      if (d.exitFullscreen) await d.exitFullscreen();
      else await d.webkitExitFullscreen?.();
    } catch {
      /* ignora */
    }
    return false;
  }, [enter]);

  return { on, supported: fullscreenSupported(), enter, toggle };
}

export type Fullscreen = ReturnType<typeof useFullscreen>;
