import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight, CalendarRange, Inbox, Minus } from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { periodFrom } from '@/lib/data';

/** Atraso da animação de entrada (cascata) de um bloco. */
export function stagger(i: number, extra?: CSSProperties): CSSProperties {
  return { ['--i' as string]: i, ...extra } as CSSProperties;
}

type Tone = 'blue' | 'violet' | 'green' | 'amber' | 'rose' | 'teal';

export function Card({
  title,
  subtitle,
  icon: Icon,
  tone = 'blue',
  actions,
  children,
  flush,
  className,
  style,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
}) {
  return (
    <section className={`card glow ${flush ? 'flush' : ''} ${className ?? ''}`} style={style} id={id}>
      {(title || actions) && (
        <header className="card-head">
          {Icon ? (
            <span className={`icon-chip ${tone}`} aria-hidden="true">
              <Icon size={16} strokeWidth={2.2} />
            </span>
          ) : null}
          <div className="grow">
            {typeof title === 'string' ? <h2 className="card-title">{title}</h2> : title}
            {subtitle ? <p className="card-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

/** Indicador simples (rótulo, valor e dica). */
export function Stat({ label, value, hint, icon: Icon, tone = 'blue', style }: { label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; tone?: Tone; style?: CSSProperties }) {
  return (
    <div className="card stat glow" style={style}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {Icon ? (
          <span className={`icon-chip ${tone}`} aria-hidden="true">
            <Icon size={16} strokeWidth={2.2} />
          </span>
        ) : null}
      </div>
      <span className="stat-value">{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

/** Variação em relação ao período anterior. `invert`: subir é ruim (ex.: perdas). */
export function Delta({ value, label, invert }: { value: number | null; label?: string; invert?: boolean }) {
  if (value === null) {
    return (
      <span className="delta neutral">
        <span className="delta-chip">novo</span>
        {label ? <span className="delta-label">{label}</span> : null}
      </span>
    );
  }
  const dir = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const good = dir === 'flat' ? 'neutral' : (dir === 'up') !== !!invert ? 'good' : 'bad';
  const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus;
  const text = `${value > 0 ? '+' : ''}${value}%`;
  return (
    <span className={`delta ${good}`}>
      <span className="delta-chip">
        <Icon size={13} strokeWidth={2.6} aria-hidden="true" />
        {text}
      </span>
      {label ? <span className="delta-label">{label}</span> : null}
    </span>
  );
}

export type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'purple' | 'accent' | 'gray';

export function Badge({ color, children, dot, pulse }: { color?: BadgeColor; children: ReactNode; dot?: boolean; pulse?: boolean }) {
  return (
    <span className={`badge ${color ?? 'gray'}`}>
      {dot ? <span className={`badge-dot ${pulse ? 'pulse' : ''}`} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle, eyebrow, icon: Icon, actions }: { title: ReactNode; subtitle?: ReactNode; eyebrow?: ReactNode; icon?: LucideIcon; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-heading">
        {Icon ? (
          <span className="page-icon" aria-hidden="true">
            <Icon size={22} strokeWidth={2} />
          </span>
        ) : null}
        <div className="grow">
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h1>{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Empty({ title, children, icon: Icon = Inbox }: { title: ReactNode; children?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        <Icon size={26} strokeWidth={1.8} />
      </span>
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-text">{children}</div> : null}
    </div>
  );
}

/** Filtro de período via GET (funciona sem JavaScript), com atalhos rápidos. */
export function PeriodForm({ de, ate, extra, keep }: { de: string; ate: string; extra?: ReactNode; keep?: Record<string, string> }) {
  const presets = [
    { label: 'Hoje', days: 1 },
    { label: '7 dias', days: 7 },
    { label: '30 dias', days: 30 },
  ].map((p) => {
    const r = periodFrom({}, p.days);
    const qs = new URLSearchParams({ ...(keep ?? {}), de: r.de, ate: r.ate });
    return { ...p, href: `?${qs.toString()}`, active: r.de === de && r.ate === ate };
  });
  return (
    <div className="period">
      <nav className="chips" aria-label="Atalhos de período">
        {presets.map((p) => (
          <Link key={p.label} href={p.href} className={`chip ${p.active ? 'active' : ''}`} aria-current={p.active ? 'true' : undefined} scroll={false}>
            {p.label}
          </Link>
        ))}
      </nav>
      <form className="period-form glass-inline" method="get">
        <CalendarRange size={16} className="period-icon" aria-hidden="true" />
        <div className="field compact">
          <label htmlFor="de">De</label>
          <input id="de" className="input" type="date" name="de" defaultValue={de} />
        </div>
        <div className="field compact">
          <label htmlFor="ate">Até</label>
          <input id="ate" className="input" type="date" name="ate" defaultValue={ate} />
        </div>
        {extra}
        <button className="btn primary" type="submit">
          Aplicar
        </button>
      </form>
    </div>
  );
}

/** Abas por link (funcionam sem JavaScript) com indicador deslizante. */
export function LinkTabs({ items, label }: { items: { href: string; label: ReactNode; active: boolean; count?: number }[]; label: string }) {
  const idx = Math.max(0, items.findIndex((i) => i.active));
  return (
    <nav className="segmented" aria-label={label} style={{ ['--n' as string]: items.length, ['--idx' as string]: idx } as CSSProperties}>
      <span className="segmented-indicator" aria-hidden="true" />
      {items.map((i) => (
        <Link key={i.href} href={i.href} className={i.active ? 'active' : ''} aria-current={i.active ? 'page' : undefined} scroll={false}>
          {i.label}
          {i.count !== undefined ? <span className="seg-count">{i.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
