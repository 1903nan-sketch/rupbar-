/** Relógio injetável (facilita testes de horários, períodos e dias de operação). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function iso(d: Date): string {
  return d.toISOString();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Data local AAAA-MM-DD. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Dia de operação: bares viram a madrugada. Antes de `startHour` (padrão 5h),
 * o pedido ainda pertence ao dia anterior — a numeração de pedidos reinicia
 * no início de cada dia de operação.
 */
export function businessDay(d: Date, startHour = 5): string {
  const shifted = new Date(d.getTime() - startHour * 3_600_000);
  return localDate(shifted);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}
