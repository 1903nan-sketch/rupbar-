'use client';
import { formatBRL } from '@rupbar/core';
import { useLayoutEffect, useRef, useState } from 'react';

export type CountFormat = 'brl' | 'int' | 'percent';

const int = new Intl.NumberFormat('pt-BR');

export function formatCount(value: number, format: CountFormat): string {
  if (format === 'brl') return formatBRL(Math.round(value));
  if (format === 'percent') return `${Math.round(value)}%`;
  return int.format(Math.round(value));
}

/**
 * Número que "conta" de zero até o valor ao montar (e entre valores quando muda).
 * Sem JavaScript ou com movimento reduzido, mostra o valor final direto.
 */
export function CountUp({ value, format = 'int', duration = 1100, className }: { value: number; format?: CountFormat; duration?: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  const first = useRef(true);

  useLayoutEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const start = first.current ? 0 : from.current;
    first.current = false;
    if (reduce || start === value) {
      from.current = value;
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p); // easeOutExpo
      const v = start + (value - start) * eased;
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setShown(start);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return (
    <span className={className}>
      <span aria-hidden="true">{formatCount(shown, format)}</span>
      <span className="sr-only">{formatCount(value, format)}</span>
    </span>
  );
}
