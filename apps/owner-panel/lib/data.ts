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
  const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 3 * 3_600_000 - (defaultDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const de = typeof params.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.de) ? params.de : start;
  const ate = typeof params.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.ate) ? params.ate : today;
  const to = new Date(`${ate}T00:00:00${tz}`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { de, ate, from: new Date(`${de}T00:00:00${tz}`).toISOString(), to: to.toISOString() };
}
