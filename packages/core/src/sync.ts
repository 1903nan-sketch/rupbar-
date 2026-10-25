/**
 * Protocolo de sincronização PC do bar ⇄ nuvem.
 *
 * - O PC é a autoridade operacional. Ele EMPURRA registros (outbox transacional)
 *   e PUXA comandos administrativos (ex.: perda registrada no site).
 * - Cada registro carrega `version` (inteiro crescente por entidade). A nuvem só
 *   aceita uma versão maior que a armazenada → idempotente e tolerante a reenvios
 *   e entregas fora de ordem.
 * - Cada comando remoto tem UUID próprio; o PC grava o resultado da aplicação em
 *   tabela com chave única antes de confirmar, então reentregas nunca aplicam
 *   duas vezes.
 */

export const SYNC_ENTITIES = [
  'establishment',
  'category',
  'product',
  'presentation',
  'supplier',
  'stock_movement',
  'stock_alert',
  'comanda',
  'comanda_item',
  'order',
  'payment',
  'cash_session',
  'cash_movement',
  'loss',
  'hookah',
  'hookah_session',
  'hookah_consumption',
  'user',
  'purchase',
  'discount_request',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export interface SyncRecord {
  /** UUID do registro de outbox (idempotência do envio). */
  outboxId: string;
  entity: SyncEntity;
  id: string;
  version: number;
  deleted: boolean;
  /** Dados já minimizados (sem hashes de senha, CPF ou telefone). */
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface PushRequest {
  deviceId: string;
  records: SyncRecord[];
}

export interface PushResponse {
  /** outboxIds aceitos ou já presentes com versão ≥ (ambos podem ser descartados). */
  acked: string[];
  rejected: { outboxId: string; reason: string }[];
}

/**
 * Comandos do painel online que o PC do bar aplica (uma única vez) e confirma.
 * O PC é a fonte da verdade: valida tudo de novo e pode recusar com o motivo.
 */
export const REMOTE_COMMAND_TYPES = [
  'loss.register', 'comanda.open', 'order.create', 'comanda_item.cancel', 'cash.open', 'cash.close', 'user.remove', 'product.set_active',
  'comanda.discount', 'discount.approve', 'discount.reject', 'comanda.close', 'stock.entry', 'stock.adjust', 'product.update',
] as const;
export type RemoteCommandType = (typeof REMOTE_COMMAND_TYPES)[number];

export const REMOTE_COMMAND_LABELS: Record<RemoteCommandType, string> = {
  'loss.register': 'Registrar perda',
  'comanda.open': 'Abrir comanda',
  'order.create': 'Lançar itens',
  'comanda_item.cancel': 'Tirar item',
  'cash.open': 'Abrir caixa',
  'cash.close': 'Fechar caixa',
  'user.remove': 'Excluir funcionário',
  'product.set_active': 'Produto à venda / fora de venda',
  'comanda.discount': 'Dar desconto',
  'discount.approve': 'Aceitar desconto',
  'discount.reject': 'Recusar desconto',
  'comanda.close': 'Encerrar comanda',
  'stock.entry': 'Entrada de estoque',
  'stock.adjust': 'Corrigir saldo',
  'product.update': 'Alterar produto',
};

export interface RemoteCommand {
  id: string;
  type: RemoteCommandType;
  payload: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
}

export type CommandResultStatus = 'applied' | 'rejected' | 'conflict';

export interface CommandResult {
  commandId: string;
  status: CommandResultStatus;
  message: string;
  result?: Record<string, unknown>;
  appliedAt: string;
}

/** Backoff exponencial com jitter (ms). attempt começa em 1. */
export function backoffMs(attempt: number, baseMs = 2_000, maxMs = 5 * 60_000, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Dados considerados desatualizados no painel após este intervalo sem sincronizar. */
export const STALE_AFTER_MS = 15 * 60_000;

export function isStale(lastSyncIso: string | null | undefined, now = Date.now()): boolean {
  if (!lastSyncIso) return true;
  const t = Date.parse(lastSyncIso);
  return Number.isNaN(t) || now - t > STALE_AFTER_MS;
}
