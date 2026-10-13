'use client';
import { formatBRL } from '@rupbar/core';
import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { compactBRL } from '@/lib/format';
import { monotonePath, niceTicks } from './geometry';

export interface AreaPoint {
  /** Rótulo curto do eixo X ("18h", "13/10"). */
  label: string;
  /** Rótulo completo para a dica e a tabela ("18h–19h", "terça-feira, 13/10"). */
  full: string;
  /** Valor em centavos. */
  value: number;
}

const W = 1000; // largura lógica do SVG (esticado com preserveAspectRatio="none")
const H = 100;
const TOP = 8; // folga no topo (% da altura)

/**
 * Gráfico de área (uma série) com linha que se desenha ao carregar, mira
 * vertical que acompanha o ponteiro, navegação por setas e tabela acessível.
 */
export function AreaChart({ points, height = 240, label, valueLabel = 'Faturamento' }: { points: AreaPoint[]; height?: number; label: string; valueLabel?: string }) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;

  const geo = useMemo(() => {
    const max = Math.max(0, ...points.map((p) => p.value));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const xs = points.map((_, i) => (n === 1 ? W / 2 : (i / (n - 1)) * W));
    const ys = points.map((p) => H - (p.value / top) * (H - TOP));
    const coords = xs.map((x, i) => [x, ys[i]!] as [number, number]);
    const line = monotonePath(coords);
    const area = n ? `${line}L${xs[n - 1]},${H}L${xs[0]},${H}Z` : '';
    let peak = -1;
    points.forEach((p, i) => {
      if (p.value > 0 && (peak < 0 || p.value > points[peak]!.value)) peak = i;
    });
    return { ticks, top, xs, ys, line, area, peak };
  }, [points, n]);

  const pct = (i: number) => ({ left: (geo.xs[i]! / W) * 100, top: (geo.ys[i]! / H) * 100 });
  const xStep = Math.max(1, Math.ceil(n / 8));

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setActive(n === 1 ? 0 : Math.round(rel * (n - 1)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const cur = active ?? n - 1;
    let next = cur;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };

  const tip = active !== null ? pct(active) : null;
  // A dica fica ao lado da mira (nunca em cima do ponto): à direita na primeira metade, à esquerda depois.
  const tipAlign = tip && tip.left > 55 ? 'end' : 'start';
  const peak = geo.peak >= 0 ? pct(geo.peak) : null;

  return (
    <figure className="area-chart" style={{ ['--plot-h' as string]: `${height}px` } as CSSProperties}>
      <div className="ac-frame">
        <div className="ac-y" aria-hidden="true">
          {geo.ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / geo.top) * (100 - TOP)}%` }}>
              {compactBRL(t)}
            </span>
          ))}
        </div>
        <div className="ac-plot">
          <div className="ac-grid" aria-hidden="true">
            {geo.ticks.map((t) => (
              <span key={t} className={t === 0 ? 'base' : ''} style={{ bottom: `${(t / geo.top) * (100 - TOP)}%` }} />
            ))}
          </div>
          <svg className="ac-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.34" />
                <stop offset="0.65" stopColor="var(--chart-1)" stopOpacity="0.08" />
                <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`stroke-${gid}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="var(--chart-1b)" />
                <stop offset="1" stopColor="var(--chart-1)" />
              </linearGradient>
            </defs>
            <path className="ac-area" d={geo.area} fill={`url(#fill-${gid})`} />
            <path className="ac-line" d={geo.line} stroke={`url(#stroke-${gid})`} vectorEffect="non-scaling-stroke" />
          </svg>
          {peak && active === null ? (
            <>
              <span className="ac-dot peak" style={{ left: `${peak.left}%`, top: `${peak.top}%` }} aria-hidden="true" />
              <span
                className={`ac-peak-label ${peak.left < 14 ? 'start' : peak.left > 86 ? 'end' : ''}`}
                style={{ left: `${peak.left}%`, top: `${peak.top}%` }}
                aria-hidden="true"
              >
                Pico {formatBRL(points[geo.peak]!.value)}
              </span>
            </>
          ) : null}
          {tip && active !== null ? (
            <>
              <span className="ac-cross" style={{ left: `${tip.left}%` }} aria-hidden="true" />
              <span className="ac-dot" style={{ left: `${tip.left}%`, top: `${tip.top}%` }} aria-hidden="true" />
              <div className={`ac-tip ${tipAlign}`} style={{ left: `${tip.left}%` }} aria-hidden="true">
                <strong>{formatBRL(points[active]!.value)}</strong>
                <span>
                  <i className="ac-key" /> {valueLabel} · {points[active]!.full}
                </span>
              </div>
            </>
          ) : null}
          <div
            className="ac-hit"
            tabIndex={0}
            role="group"
            aria-label={`${label}. Use as setas para percorrer os valores.`}
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
          />
          <div className="sr-only" aria-live="polite">
            {active !== null ? `${points[active]!.full}: ${formatBRL(points[active]!.value)}` : ''}
          </div>
        </div>
      </div>
      <div className="ac-x" aria-hidden="true">
        {points.map((p, i) =>
          (n - 1 - i) % xStep === 0 ? (
            <span
              key={p.full}
              className={`${i === 0 ? 'first' : i === n - 1 ? 'last' : ''} ${((n - 1 - i) / xStep) % 2 === 1 ? 'minor' : ''}`}
              style={{ left: `${pct(i).left}%` }}
            >
              {p.label}
            </span>
          ) : null,
        )}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Período</th>
            <th scope="col">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.full}>
              <th scope="row">{p.full}</th>
              <td>{formatBRL(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
