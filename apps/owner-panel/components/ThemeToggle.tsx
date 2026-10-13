'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { THEME_KEY as KEY } from '@/lib/theme';

type Theme = 'system' | 'light' | 'dark';
const NEXT: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' };
const LABEL: Record<Theme, string> = { system: 'Tema do sistema', dark: 'Tema escuro', light: 'Tema claro' };

function apply(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* armazenamento indisponível: vale só para esta visita */
  }
}

export function ThemeToggle({ withLabel }: { withLabel?: boolean }) {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setTheme(t === 'light' || t === 'dark' ? t : 'system');
  }, []);
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <button
      type="button"
      className={`btn ghost ${withLabel ? '' : 'icon'}`}
      onClick={() => {
        const next = NEXT[theme];
        apply(next);
        setTheme(next);
      }}
      aria-label={`${LABEL[theme]} (clique para alternar)`}
      title={LABEL[theme]}
    >
      <Icon size={17} aria-hidden="true" />
      {withLabel ? <span>{LABEL[theme]}</span> : null}
    </button>
  );
}
