/**
 * Tema claro, escuro ou automático (igual ao Windows/celular). A escolha fica
 * no aparelho: o PC do caixa pode ser claro e o celular do garçom escuro.
 */
import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'rupbar_theme';
const listeners = new Set<() => void>();
let current: ThemeChoice = 'system';

export const THEME_LABEL: Record<ThemeChoice, string> = { system: 'Automático', light: 'Claro', dark: 'Escuro' };
/** Ordem do botão da barra: automático → claro → escuro → automático. */
export const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: ThemeChoice, save = true): void {
  current = t;
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  if (save) {
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      // Sem armazenamento (aba anônima): vale só até fechar.
    }
  }
  listeners.forEach((l) => l());
}

/** Aplica a escolha salva antes de desenhar a tela (sem piscar). */
export function initTheme(): void {
  applyTheme(readTheme(), false);
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const t = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return [t, applyTheme];
}
