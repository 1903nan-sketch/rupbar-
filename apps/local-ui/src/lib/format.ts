export { formatBRL, formatQty, maskPhone, firstName, parseBRL, PAYMENT_METHODS, STATIONS, LOSS_REASONS, HOOKAH_STATUS } from '@rupbar/core';

const tf = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dtf = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const longDf = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

export const fmtTime = (iso: string | null | undefined) => (iso ? tf.format(new Date(iso)) : '—');
export const fmtDate = (iso: string | null | undefined) => (iso ? df.format(new Date(iso)) : '—');
export const fmtDateTime = (iso: string | null | undefined) => (iso ? dtf.format(new Date(iso)) : '—');
export const fmtLongDate = (d: Date) => longDf.format(d);

/** "há 5 min", "há 1 h 20" */
export function elapsed(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')}`;
}

export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
}

/** Período local [início do dia, início do dia seguinte) em ISO. */
export function dayRange(date: Date, days = 1): { from: string; to: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function toInputDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fromInputDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/** Texto legível sobre a cor de destaque (branco ou quase-preto). */
export function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return lum > 0.45 ? '#1d1d1f' : '#ffffff';
}

/** Entrada numérica decimal pt-BR ("1,5") → número. */
export function parseDecimal(s: string): number | null {
  const t = s.trim().replace(/\./g, '').replace(',', '.');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function fmtDecimal(n: number, max = 3): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: max }).format(n);
}
