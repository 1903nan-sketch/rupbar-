'use client';
import { useEffect, useRef } from 'react';

/**
 * Leva a tela até o cartão onde está (ex.: a comanda tocada na lista). Sem
 * isso, no celular o detalhe abria fora da tela e parecia que nada acontecia.
 */
export function ScrollHere() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const card = ref.current?.closest('.card');
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    if (top >= 64 && top <= window.innerHeight * 0.5) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }, []);
  return <span ref={ref} hidden />;
}
