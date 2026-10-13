/** Formatação de datas e números para o painel (fuso de Brasília, pt-BR). */

const TZ = 'America/Sao_Paulo';

/** "13/10 21:40" */
export function fmtShort(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}

/** "13/10/2026, 21:40:12" */
export function fmtFull(iso: string | null | undefined, empty = 'nunca'): string {
  return iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ }) : empty;
}

/** "21:40" */
export function fmtTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—';
}

/** Tempo relativo curto: "agora", "há 5 min", "há 2 h", "há 3 dias". */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}

/** Duração desde `iso`: "45 min", "1 h 20 min". */
export function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "2026-10-13" -> "13/10" */
export function dayMonth(day: string): string {
  const [, m, d] = day.split('-');
  return `${d}/${m}`;
}

/** "2026-10-13" -> "terça-feira, 13/10" */
export function weekdayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${d.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' })}, ${dayMonth(day)}`;
}

/** Valor monetário compacto para eixos: "R$ 0", "R$ 850", "R$ 1,2 mil", "R$ 3 mi". */
export function compactBRL(cents: number): string {
  const v = cents / 100;
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
}

/** Variação percentual entre dois valores; null quando não há base de comparação. */
export function deltaPct(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

/** Saudação conforme o horário de Brasília. */
export function greeting(now = Date.now()): string {
  const h = new Date(now - 3 * 3_600_000).getUTCHours();
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** "terça-feira, 13 de outubro" */
export function longToday(now = Date.now()): string {
  return new Date(now).toLocaleDateString('pt-BR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
}
