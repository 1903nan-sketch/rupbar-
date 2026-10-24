import { Monitor, Moon, Sun } from 'lucide-react';
import { NEXT_THEME, THEME_LABEL, useTheme, type ThemeChoice } from '../lib/theme';
import { Button } from './ui';

const ICON: Record<ThemeChoice, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/** Botão da barra: troca automático → claro → escuro. */
export function ThemeButton({ size = 16 }: { size?: number }) {
  const [theme, setTheme] = useTheme();
  const Icon = ICON[theme];
  const next = NEXT_THEME[theme];
  return (
    <Button
      variant="plain"
      size="small"
      icon={<Icon size={size} />}
      title={`Tema: ${THEME_LABEL[theme]} — toque para ${THEME_LABEL[next].toLowerCase()}`}
      aria-label={`Tema ${THEME_LABEL[theme]}. Mudar para ${THEME_LABEL[next]}`}
      onClick={() => setTheme(next)}
    />
  );
}

/** As três opções lado a lado (Configurações). */
export function ThemeChooser() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="theme-chooser" role="radiogroup" aria-label="Tema">
      {(['light', 'dark', 'system'] as const).map((t) => {
        const Icon = ICON[t];
        return (
          <button key={t} type="button" role="radio" aria-checked={theme === t} className={`theme-option ${t} ${theme === t ? 'active' : ''}`} onClick={() => setTheme(t)}>
            <span className="theme-preview" aria-hidden="true"><Icon size={20} /></span>
            <strong>{THEME_LABEL[t]}</strong>
            <span className="tiny muted">{t === 'system' ? 'Igual ao Windows ou ao celular' : t === 'light' ? 'Fundo claro' : 'Fundo escuro'}</span>
          </button>
        );
      })}
    </div>
  );
}
