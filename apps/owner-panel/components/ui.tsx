import type { ReactNode } from 'react';

export function Card({ title, actions, children, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`card ${flush ? 'flush' : ''}`}>
      {(title || actions) && (
        <div className="card-title" style={flush ? { padding: '16px 16px 0' } : undefined}>
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {hint ? <span className="small muted">{hint}</span> : null}
    </div>
  );
}

export function Badge({ color, children }: { color?: 'green' | 'orange' | 'red' | 'blue' | 'purple' | 'accent'; children: ReactNode }) {
  return <span className={`badge ${color ?? ''}`}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <div className="subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="strong" style={{ color: 'var(--text)' }}>{title}</div>
      {children ? <div className="small">{children}</div> : null}
    </div>
  );
}

/** Filtro de período via GET (funciona sem JavaScript). */
export function PeriodForm({ de, ate, extra }: { de: string; ate: string; extra?: ReactNode }) {
  return (
    <form className="period-form" method="get">
      <div className="field"><label htmlFor="de">De</label><input id="de" className="input" type="date" name="de" defaultValue={de} /></div>
      <div className="field"><label htmlFor="ate">Até</label><input id="ate" className="input" type="date" name="ate" defaultValue={ate} /></div>
      {extra}
      <button className="btn primary" type="submit">Aplicar</button>
    </form>
  );
}

export function Bars({ rows }: { rows: { label: string; value: number; display: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="col" style={{ gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div className="row between small"><span className="ellipsis">{r.label}</span><span className="num strong">{r.display}</span></div>
          <div className="progress"><span style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
