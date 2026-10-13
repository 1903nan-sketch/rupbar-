import type { CSSProperties, ReactNode } from 'react';

/** Bloco com brilho deslizante enquanto os dados carregam. */
export function Sk({ w, h = 14, r, style, className }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties; className?: string }) {
  return <span className={`sk ${className ?? ''}`} style={{ width: w ?? '100%', height: h, borderRadius: r, ...style }} aria-hidden="true" />;
}

function Loading({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="stack-l skeleton-page" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function HeaderSkeleton({ actions = true }: { actions?: boolean }) {
  return (
    <div className="page-header">
      <div className="page-heading">
        <Sk w={48} h={48} r={16} />
        <div className="col" style={{ gap: 10 }}>
          <Sk w={90} h={11} />
          <Sk w={220} h={26} r={10} />
          <Sk w={300} h={12} />
        </div>
      </div>
      {actions ? <Sk w={320} h={44} r={14} /> : null}
    </div>
  );
}

export function StatSkeleton() {
  return (
    <div className="card stat">
      <div className="stat-top">
        <Sk w={110} h={12} />
        <Sk w={34} h={34} r={11} />
      </div>
      <Sk w="70%" h={30} r={10} />
      <Sk w="55%" h={12} />
    </div>
  );
}

export function RowsSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="card flush">
      <div className="sk-table-head">
        {Array.from({ length: cols }, (_, i) => (
          <Sk key={i} w={i === 0 ? '30%' : '14%'} h={10} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="sk-row" style={{ ['--i' as string]: r } as CSSProperties}>
          {Array.from({ length: cols }, (_, i) => (
            <Sk key={i} w={i === 0 ? `${40 - (r % 3) * 6}%` : `${12 + ((r + i) % 3) * 3}%`} h={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ h = 260 }: { h?: number }) {
  return (
    <div className="card">
      <div className="card-head">
        <Sk w={34} h={34} r={11} />
        <div className="grow col" style={{ gap: 8 }}>
          <Sk w={160} h={14} />
          <Sk w={220} h={11} />
        </div>
      </div>
      <div className="sk-chart" style={{ height: h }}>
        {Array.from({ length: 14 }, (_, i) => (
          <Sk key={i} h={`${30 + Math.round(Math.abs(Math.sin(i * 1.3)) * 60)}%`} r={6} />
        ))}
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <Loading label="Carregando visão geral…">
      <HeaderSkeleton />
      <div className="grid-4">
        {Array.from({ length: 4 }, (_, i) => (
          <StatSkeleton key={i} />
        ))}
      </div>
      <div className="dash-main">
        <ChartSkeleton h={280} />
        <ChartSkeleton h={280} />
      </div>
      <div className="grid-3">
        <RowsSkeleton rows={5} cols={2} />
        <RowsSkeleton rows={5} cols={2} />
        <RowsSkeleton rows={5} cols={2} />
      </div>
    </Loading>
  );
}

export function TablePageSkeleton({ label, stats = 0, rows = 8, cols = 5, chart = false }: { label: string; stats?: number; rows?: number; cols?: number; chart?: boolean }) {
  return (
    <Loading label={label}>
      <HeaderSkeleton />
      {stats ? (
        <div className={stats >= 4 ? 'grid-4' : 'grid-3'}>
          {Array.from({ length: stats }, (_, i) => (
            <StatSkeleton key={i} />
          ))}
        </div>
      ) : null}
      {chart ? (
        <div className="grid-2">
          <ChartSkeleton h={220} />
          <ChartSkeleton h={220} />
        </div>
      ) : null}
      <RowsSkeleton rows={rows} cols={cols} />
    </Loading>
  );
}
