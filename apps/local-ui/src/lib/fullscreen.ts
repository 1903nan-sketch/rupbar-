import { useCallback, useEffect, useState } from 'react';

/**
 * Tela cheia de verdade: no aplicativo do Windows usa a janela nativa (Tauri),
 * no navegador usa a Fullscreen API. F11 alterna em qualquer tela.
 */
interface TauriWindow {
  setFullscreen(v: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
}

function tauriWindow(): TauriWindow | null {
  const t = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindow } } }).__TAURI__;
  try {
    return t?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

export async function isFullscreen(): Promise<boolean> {
  const w = tauriWindow();
  if (w) {
    try {
      return await w.isFullscreen();
    } catch {
      /* sem permissão: usa a API do navegador */
    }
  }
  return !!document.fullscreenElement;
}

export async function setFullscreen(on: boolean): Promise<void> {
  const w = tauriWindow();
  if (w) {
    try {
      await w.setFullscreen(on);
      return;
    } catch {
      /* segue para a API do navegador */
    }
  }
  if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen?.().catch(() => undefined);
  if (!on && document.fullscreenElement) await document.exitFullscreen?.().catch(() => undefined);
}

export async function toggleFullscreen(): Promise<boolean> {
  const next = !(await isFullscreen());
  await setFullscreen(next);
  return next;
}

export function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const refresh = useCallback(() => void isFullscreen().then(setOn), []);
  useEffect(() => {
    refresh();
    document.addEventListener('fullscreenchange', refresh);
    window.addEventListener('resize', refresh);
    return () => {
      document.removeEventListener('fullscreenchange', refresh);
      window.removeEventListener('resize', refresh);
    };
  }, [refresh]);
  const toggle = useCallback(() => void toggleFullscreen().then(setOn), []);
  return [on, toggle];
}
