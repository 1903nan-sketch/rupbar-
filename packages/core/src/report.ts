/**
 * Relatório completo de um dia (ou período): o mesmo formato sai do PC do bar
 * e do painel online, vira tela, PDF e cupom na impressora do caixa.
 */
import { PAYMENT_METHODS } from './domain';
import type { Cents } from './money';

/** O dia do bar vai das 05:00 às 05:00 do dia seguinte (a noite vira a madrugada). */
export const BUSINESS_DAY_START_HOUR = 5;
/** Brasília (sem horário de verão). */
export const BAR_UTC_OFFSET = '-03:00';
export const BAR_TIME_ZONE = 'America/Sao_Paulo';

export interface FullReport {
  barName: string;
  /** Início e fim (ISO) do período. */
  from: string;
  to: string;
  /** Dias escolhidos (AAAA-MM-DD), para o título. */
  de: string;
  ate: string;
  generatedAt: string;
  summary: {
    /** Itens vendidos (sem consumo de funcionário), a preço de cardápio. */
    grossCents: Cents;
    /** Descontos dados nas comandas encerradas no período. */
    discountsCents: Cents;
    /** Taxa de serviço das comandas encerradas no período. */
    serviceFeeCents: Cents;
    /** Pagamentos recebidos no período. */
    receivedCents: Cents;
    costCents: Cents;
    itemsSold: number;
    /** Comandas de cliente encerradas. */
    closedComandas: number;
    quickSales: number;
    canceledComandas: number;
    /** Itens cancelados (valor). */
    canceledCents: Cents;
    /** Pagamentos estornados. */
    reversedCents: Cents;
    /** Consumo de funcionários (fora das vendas), a preço de cardápio. */
    staffCents: Cents;
    lossesCents: Cents;
    /** Comandas abertas no período que ainda não foram encerradas. */
    stillOpen: number;
    stillOpenCents: Cents;
  };
  payments: { method: string; count: number; totalCents: Cents }[];
  byHour: { hour: number; totalCents: Cents }[];
  byDay: { day: string; totalCents: Cents; costCents: Cents }[];
  byCategory: { category: string; qty: number; totalCents: Cents; costCents: Cents }[];
  products: { name: string; presentation: string; qty: number; totalCents: Cents; costCents: Cents }[];
  byWaiter: { name: string; orders: number; totalCents: Cents }[];
  discounts: { comanda: string; customer: string | null; reason: string | null; discountCents: Cents; closedAt: string | null; closedBy: string | null }[];
  cancellations: { at: string; product: string; qty: number; totalCents: Cents; reason: string | null; by: string | null }[];
  staffConsumption: { name: string; items: number; valueCents: Cents; costCents: Cents }[];
  cashSessions: {
    number: number; status: string; openedAt: string; openedBy: string | null; closedAt: string | null; closedBy: string | null;
    openingCents: Cents; expectedCents: Cents | null; countedCents: Cents | null; differenceCents: Cents | null;
  }[];
  cashMovements: { at: string; type: 'withdrawal' | 'supply'; amountCents: Cents; reason: string; by: string | null }[];
  losses: { product: string; reason: string; count: number; costCents: Cents }[];
  hookah: { sessions: number; totalCents: Cents };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** AAAA-MM-DD de um dia que existe (30/02 não). */
export function isValidDay(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Soma dias a AAAA-MM-DD. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dia do bar de um instante (antes das 05:00 ainda é o dia anterior). */
export function barDay(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() - 3 * 3_600_000 - BUSINESS_DAY_START_HOUR * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/** Janela do relatório: de 05:00 do primeiro dia às 05:00 do dia seguinte ao último. */
export function reportWindow(de: string, ate: string = de): { de: string; ate: string; from: string; to: string } {
  if (!isValidDay(de) || !isValidDay(ate)) throw new Error('Data inválida');
  if (ate < de) [de, ate] = [ate, de];
  const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0');
  return {
    de, ate,
    from: new Date(`${de}T${h}:00:00${BAR_UTC_OFFSET}`).toISOString(),
    to: new Date(`${addDays(ate, 1)}T${h}:00:00${BAR_UTC_OFFSET}`).toISOString(),
  };
}

const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

/** "sexta-feira, 24/10/2026" ou "18/10/2026 a 24/10/2026". */
export function reportTitle(de: string, ate: string): string {
  const d = (s: string) => new Date(`${s}T12:00:00Z`);
  if (de === ate) {
    const t = dayFmt.format(d(de));
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return `${shortFmt.format(d(de))} a ${shortFmt.format(d(ate))}`;
}

/** "das 05:00 de 24/10 às 05:00 de 25/10" — deixa claro que a madrugada conta. */
export function reportWindowLabel(de: string, ate: string): string {
  const dm = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  const h = `${String(BUSINESS_DAY_START_HOUR).padStart(2, '0')}:00`;
  return `das ${h} de ${dm(de)} às ${h} de ${dm(addDays(ate, 1))}`;
}

export function paymentLabel(method: string): string {
  return (PAYMENT_METHODS as Record<string, string>)[method] ?? method;
}

/** Totais derivados (iguais na tela, no PDF e no cupom). */
export function reportTotals(r: FullReport) {
  const s = r.summary;
  const net = s.grossCents - s.discountsCents + s.serviceFeeCents;
  const tickets = s.closedComandas + s.quickSales;
  return {
    netCents: net,
    marginCents: s.grossCents - s.costCents,
    marginPct: s.grossCents ? Math.round(((s.grossCents - s.costCents) / s.grossCents) * 100) : 0,
    tickets,
    averageTicketCents: tickets ? Math.round(s.receivedCents / tickets) : 0,
  };
}

/** Nome do arquivo: vendas-2026-10-24.pdf ou vendas-2026-10-18-a-2026-10-24.pdf. */
export function reportFileName(de: string, ate: string, ext = 'pdf'): string {
  return de === ate ? `vendas-${de}.${ext}` : `vendas-${de}-a-${ate}.${ext}`;
}
