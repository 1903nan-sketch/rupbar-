import { monotonePath } from './geometry';

/** Minigráfico de tendência (decorativo; os valores estão no gráfico principal). */
export function Sparkline({ values, id }: { values: number[]; id: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 30 - (v / max) * 26] as [number, number]);
  const line = monotonePath(pts);
  return (
    <svg className="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.3" />
          <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L100,30L0,30Z`} fill={`url(#spark-${id})`} />
      <path d={line} className="sparkline-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
