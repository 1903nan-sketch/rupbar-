'use client';
import { formatBRL } from '@rupbar/core';
import { useState, type CSSProperties } from 'react';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  /** Cor da série (variável CSS, ex.: "var(--series-1)"). Segue a entidade, não a posição. */
  color: string;
  /** Texto extra na legenda (ex.: "12 pagamentos"). */
  meta?: string;
}

const R = 46;
const C = 2 * Math.PI * R;
const GAP = 1.6; // vão da cor da superfície entre as fatias

/**
 * Rosca de composição (até 6 fatias) com legenda sempre visível: nome, valor
 * e percentual. Passar o mouse ou focar uma linha destaca a fatia.
 */
export function Donut({ segments, centerLabel, label }: { segments: DonutSegment[]; centerLabel: string; label: string }) {
  const [active, setActive] = useState<string | null>(null);
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((a, s) => a + s.value, 0);
  const gap = shown.length > 1 ? GAP : 0;
  let offset = 0;
  const arcs = shown.map((s, i) => {
    const len = total ? (s.value / total) * C : 0;
    const arc = { ...s, dash: Math.max(0.001, len - gap), offset, i };
    offset += len;
    return arc;
  });
  const cur = shown.find((s) => s.key === active);
  const pct = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : 0);

  return (
    <div className="donut">
      <div className="donut-figure">
        <svg viewBox="0 0 120 120" className="donut-svg" role="img" aria-label={`${label}: ${shown.map((s) => `${s.label} ${pct(s.value)}%`).join(', ')}`}>
          <circle cx="60" cy="60" r={R} className="donut-track" />
          <g transform="rotate(-90 60 60)">
            {arcs.map((a) => (
              <circle
                key={a.key}
                cx="60"
                cy="60"
                r={R}
                className={`donut-arc ${active && active !== a.key ? 'dim' : ''} ${active === a.key ? 'on' : ''}`}
                style={{ stroke: a.color, strokeDasharray: `${a.dash} ${C}`, strokeDashoffset: -a.offset, ['--i' as string]: a.i, ['--c' as string]: C } as CSSProperties}
                onPointerEnter={() => setActive(a.key)}
                onPointerLeave={() => setActive(null)}
              />
            ))}
          </g>
        </svg>
        <div className="donut-center" aria-hidden="true">
          {cur ? (
            <>
              <strong>{pct(cur.value).toLocaleString('pt-BR')}%</strong>
              <span>{cur.label}</span>
            </>
          ) : (
            <>
              <strong>{formatBRL(total)}</strong>
              <span>{centerLabel}</span>
            </>
          )}
        </div>
      </div>
      <ul className="donut-legend">
        {shown.map((s, i) => (
          <li
            key={s.key}
            tabIndex={0}
            className={active === s.key ? 'on' : ''}
            style={{ ['--i' as string]: i } as CSSProperties}
            onPointerEnter={() => setActive(s.key)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(s.key)}
            onBlur={() => setActive(null)}
          >
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            <span className="grow">
              <span className="donut-name">{s.label}</span>
              {s.meta ? <span className="donut-meta">{s.meta}</span> : null}
            </span>
            <span className="donut-val">
              <strong>{formatBRL(s.value)}</strong>
              <span>{pct(s.value).toLocaleString('pt-BR')}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
