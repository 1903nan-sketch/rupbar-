/**
 * WhatsApp: regras compartilhadas entre o servidor e a interface
 * (número no formato dos provedores, endereço e estados da Evolution API).
 */
import { normalizePhoneBR } from './validators';

/** Número no formato dos provedores (Evolution): 55 + DDD + número, só dígitos. */
export function phoneToWhatsApp(input: string): string | null {
  const n = normalizePhoneBR(input);
  return n ? `55${n}` : null;
}

/** Estado bruto da Evolution em /instance/connectionState. */
export type EvolutionRawState = 'open' | 'close' | 'connecting';

/** Estado apresentado ao proprietário. */
export type WaConnectionStatus = 'connected' | 'waiting_qr' | 'disconnected' | 'not_found';

export const WA_CONNECTION_STATUS: Record<WaConnectionStatus, string> = {
  connected: 'Conectado',
  waiting_qr: 'Aguardando QR',
  disconnected: 'Desconectado',
  not_found: 'Instância não encontrada',
};

/** open → conectado; connecting → aguardando leitura do QR; demais → desconectado. */
export function evolutionStatus(state: string | null | undefined): WaConnectionStatus {
  if (state === 'open') return 'connected';
  if (state === 'connecting') return 'waiting_qr';
  return 'disconnected';
}

/** Nome de instância aceito: letras, números, ".", "-" e "_" (sem espaços). */
export const EVOLUTION_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

const LOCAL_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/**
 * Normaliza o endereço da Evolution colado pelo usuário: aceita sem
 * "https://", com barra final ou o link do painel (".../manager").
 * Endereços da rede local sem protocolo usam http.
 */
export function normalizeEvolutionUrl(input: string): string {
  let v = input.replace(/[^\x21-\x7E]/g, '').trim();
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `${LOCAL_HOST_RE.test(v) ? 'http' : 'https'}://${v}`;
  v = v.replace(/[?#].*$/, '');
  v = v.replace(/\/manager(\/.*)?$/i, '');
  return v.replace(/\/+$/, '');
}
