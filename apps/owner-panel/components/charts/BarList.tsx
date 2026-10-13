import type { CSSProperties, ReactNode } from 'react';

export interface BarRow {
  key: string;
  label: ReactNode;
  sub?: ReactNode;
  value: number;
  display: string;
  meta?: ReactNode;
}

/**
 * Lista de barras horizontais (uma série, uma cor). O valor fica escrito ao
 * lado de cada barra, então nada depende só de passar o mouse.
 */
export function BarList({ rows, ranked, label }: { rows: BarRow[]; ranked?: boolean; label?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className={`barlist ${ranked ? 'ranked' : ''}`} aria-label={label}>
      {rows.map((r, i) => (
        <li key={r.key} className="barlist-row" style={{ ['--i' as string]: i } as CSSProperties}>
          {ranked ? (
            <span className="barlist-rank" aria-hidden="true">
              {i + 1}
            </span>
          ) : null}
          <div className="barlist-body">
            <div className="barlist-text">
              <span className="barlist-label">
                {r.label}
                {r.sub ? <span className="barlist-sub"> · {r.sub}</span> : null}
              </span>
              <span className="barlist-value">{r.display}</span>
            </div>
            <div className="barlist-track" aria-hidden="true">
              <span className="barlist-fill" style={{ ['--w' as string]: `${Math.max(1.5, (r.value / max) * 100)}%` } as CSSProperties} />
            </div>
            {r.meta ? <div className="barlist-meta">{r.meta}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
