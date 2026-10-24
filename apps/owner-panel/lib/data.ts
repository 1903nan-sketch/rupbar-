import type { PaymentMethod } from '@rupbar/core';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase/server';

export interface Establishment {
  id: string;
  trade_name: string;
}

export interface DeviceStatus {
  id: string;
  name: string;
  last_seen_at: string | null;
  last_sync_at: string | null;
  pending_count: number;
  app_version: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Retorno de `rupbar_sales_summary` (centavos inteiros). */
export interface SalesSummary {
  grossCents: number;
  costCents: number;
  itemsSold: number;
  receivedCents: number;
  closedComandas: number;
  /** Consumo de funcionário (fora das vendas): valor de cardápio e custo. PC antigo não envia. */
  staffCents?: number;
  staffCostCents?: number;
  byDay: { day: string; total: number; cost: number }[];
  byMethod: { method: PaymentMethod; total: number; count: number }[];
  byCategory: { category: string; total: number; qty: number; cost: number }[];
  topProducts: { product_id: string; product_name: string; presentation_name: string; qty: number; total: number; cost: number }[];
}

type Sb = Awaited<ReturnType<typeof supabaseServer>>;

const TZ_OFFSET_MS = 3 * 3_600_000; // America/Sao_Paulo (sem horário de verão)
const DAY_MS = 86_400_000;

/** Estabelecimento atual (cookie) entre os do proprietário logado. */
export async function currentEstablishment() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');
  const { data } = await sb.from('establishments').select('id, trade_name').order('created_at');
  const list = (data ?? []) as Establishment[];
  const chosen = (await cookies()).get('rupbar_est')?.value;
  const est = list.find((e) => e.id === chosen) ?? list[0] ?? null;
  return { sb, user, establishments: list, est };
}

/** Versão do RupBar no PC a partir da qual ele aplica as ações enviadas pelo painel. */
export const OWNER_ACTIONS_VERSION = '0.4.0';

/** `v` (ex.: "0.2.0") é igual ou mais nova que `min`? Sem versão conta como antiga. */
export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const parse = (x: string) => x.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  if (!v) return false;
  const a = parse(v);
  const b = parse(min);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

export async function deviceStatus(establishmentId: string): Promise<DeviceStatus | null> {
  const sb = await supabaseServer();
  const { data } = await sb
    .from('devices')
    .select('id, name, last_seen_at, last_sync_at, pending_count, app_version, revoked_at, created_at')
    .eq('establishment_id', establishmentId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  return (data?.[0] as DeviceStatus) ?? null;
}

/** Período a partir de ?de=AAAA-MM-DD&ate=AAAA-MM-DD (fuso de Brasília). */
export function periodFrom(params: Record<string, string | string[] | undefined>, defaultDays = 7) {
  const tz = '-03:00';
  const today = new Date(Date.now() - TZ_OFFSET_MS).toISOString().slice(0, 10);
  const start = new Date(Date.now() - TZ_OFFSET_MS - (defaultDays - 1) * DAY_MS).toISOString().slice(0, 10);
  const de = typeof params.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.de) ? params.de : start;
  const ate = typeof params.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.ate) ? params.ate : today;
  const to = new Date(`${ate}T00:00:00${tz}`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { de, ate, from: new Date(`${de}T00:00:00${tz}`).toISOString(), to: to.toISOString() };
}

// ------------------------------------------------------------ visão geral

export type DashboardPeriodKey = 'hoje' | '7d' | '30d';

export const DASHBOARD_PERIODS: { key: DashboardPeriodKey; label: string; days: number; compare: string }[] = [
  { key: 'hoje', label: 'Hoje', days: 1, compare: 'vs. ontem no mesmo horário' },
  { key: '7d', label: '7 dias', days: 7, compare: 'vs. 7 dias anteriores' },
  { key: '30d', label: '30 dias', days: 30, compare: 'vs. 30 dias anteriores' },
];

/**
 * Período da visão geral (?periodo=hoje|7d|30d) e a janela anterior de mesmo
 * tamanho, cortada no mesmo horário de hoje para a comparação ser justa.
 */
export function dashboardPeriod(param: string | string[] | undefined) {
  const def = DASHBOARD_PERIODS.find((p) => p.key === param) ?? DASHBOARD_PERIODS[0]!;
  const cur = periodFrom({}, def.days);
  const shift = def.days * DAY_MS;
  const now = Date.now();
  return {
    ...def,
    ...cur,
    prevFrom: new Date(Date.parse(cur.from) - shift).toISOString(),
    prevTo: new Date(Math.min(now, Date.parse(cur.to)) - shift).toISOString(),
  };
}

export async function salesSummary(sb: Sb, establishmentId: string, from: string, to: string): Promise<SalesSummary | null> {
  const { data } = await sb.rpc('rupbar_sales_summary', { p_establishment_id: establishmentId, p_from: from, p_to: to });
  return (data as SalesSummary | null) ?? null;
}

export async function lossesTotal(sb: Sb, establishmentId: string, from: string, to: string): Promise<number> {
  const { data } = await sb.rpc('rupbar_losses_report', { p_establishment_id: establishmentId, p_from: from, p_to: to });
  return Number((data as { totalCostCents?: number } | null)?.totalCostCents ?? 0);
}

/** Atendimentos (comandas e vendas rápidas não canceladas) abertos no período. */
export async function comandaCounts(sb: Sb, establishmentId: string, from: string, to: string) {
  const base = () =>
    sb.from('v_comandas').select('id', { count: 'exact', head: true }).eq('establishment_id', establishmentId).gte('opened_at', from).lt('opened_at', to).neq('status', 'canceled').neq('kind', 'staff');
  const [{ count: total }, { count: quick }] = await Promise.all([base(), base().eq('kind', 'quick')]);
  return { total: total ?? 0, quick: quick ?? 0 };
}

/** Faturamento por hora do dia (fuso de Brasília), a partir dos itens vendidos. */
export async function salesByHour(sb: Sb, establishmentId: string, from: string, to: string): Promise<number[]> {
  const hours = Array.from({ length: 24 }, () => 0);
  const PAGE = 1000;
  for (let page = 0; page < 10; page++) {
    const { data } = await sb
      .from('v_comanda_items')
      .select('created_at, quantity, unit_price_cents')
      .eq('establishment_id', establishmentId)
      .eq('status', 'active')
      .eq('staff', false)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    for (const r of data ?? []) {
      const h = new Date(Date.parse(r.created_at as string) - TZ_OFFSET_MS).getUTCHours();
      hours[h]! += Number(r.quantity) * Number(r.unit_price_cents);
    }
    if (!data || data.length < PAGE) break;
  }
  return hours;
}

export interface ActiveHookah {
  id: string;
  mode: 'legacy' | 'house' | 'own' | string;
  customer_name: string | null;
  started_at: string | null;
  rosh_count: number | null;
}

export async function activeHookahs(sb: Sb, establishmentId: string): Promise<ActiveHookah[]> {
  const { data } = await sb
    .from('v_hookah_sessions')
    .select('id, mode, customer_name, started_at, rosh_count')
    .eq('establishment_id', establishmentId)
    .eq('status', 'active')
    .order('started_at');
  return (data ?? []) as ActiveHookah[];
}

/** Hora atual em Brasília (0–23). */
export function hourInBrazil(now = Date.now()): number {
  return new Date(now - TZ_OFFSET_MS).getUTCHours();
}

/** Lista contínua de dias (AAAA-MM-DD) entre `de` e `ate`, inclusive. */
export function daysBetween(de: string, ate: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${ate}T00:00:00Z`);
  for (let t = Date.parse(`${de}T00:00:00Z`); t <= end && out.length < 400; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
