'use client';
import { addDays } from '@rupbar/core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Escolha do dia (Hoje, Ontem e setas) ou do período (de/até). */
export function ReportPeriod({ mode, de, ate, today }: { mode: 'dia' | 'periodo'; de: string; ate: string; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [from, setFrom] = useState(de);
  const [to, setTo] = useState(ate);
  const go = (q: Record<string, string>) => start(() => router.push(`/relatorios?${new URLSearchParams(q).toString()}`, { scroll: false }));
  const day = (d: string) => go({ de: d });
  return (
    <div className={`report-period-body${pending ? ' busy' : ''}`}>
      {mode === 'dia' ? (
        <div className="report-period-row">
          <button type="button" className="btn ghost icon" aria-label="Dia anterior" onClick={() => day(addDays(de, -1))}><ChevronLeft size={18} aria-hidden="true" /></button>
          <input className="input" type="date" aria-label="Dia" value={de} max={today} onChange={(e) => e.target.value && day(e.target.value)} />
          <button type="button" className="btn ghost icon" aria-label="Próximo dia" disabled={de >= today} onClick={() => day(addDays(de, 1))}><ChevronRight size={18} aria-hidden="true" /></button>
          <button type="button" className={`chip${de === today ? ' active' : ''}`} onClick={() => day(today)}>Hoje</button>
          <button type="button" className={`chip${de === addDays(today, -1) ? ' active' : ''}`} onClick={() => day(addDays(today, -1))}>Ontem</button>
        </div>
      ) : (
        <form className="report-period-row" onSubmit={(e) => { e.preventDefault(); go({ modo: 'periodo', de: from, ate: to }); }}>
          <label className="field compact"><span>De</span><input className="input" type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field compact"><span>Até</span><input className="input" type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="submit" className="btn primary">Ver</button>
          {[7, 30].map((n) => (
            <button key={n} type="button" className="chip" onClick={() => go({ modo: 'periodo', de: addDays(today, -(n - 1)), ate: today })}>{n} dias</button>
          ))}
          <button type="button" className="chip" onClick={() => go({ modo: 'periodo', de: `${today.slice(0, 8)}01`, ate: today })}>Este mês</button>
        </form>
      )}
    </div>
  );
}
