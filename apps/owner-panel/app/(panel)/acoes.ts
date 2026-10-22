'use server';
import type { RemoteCommandType } from '@rupbar/core';
import { revalidatePath } from 'next/cache';
import { currentEstablishment, deviceStatus, OWNER_ACTIONS_VERSION, versionAtLeast } from '@/lib/data';

export interface ActionState {
  ok: boolean;
  message: string;
}

const UUID = /^[0-9a-f-]{36}$/;
const WAIT = 'Enviado. O PC do bar aplica em alguns segundos (veja em "Ações enviadas").';

/** Valor em reais digitado ("1.234,56", "50") → centavos; null se inválido. */
function cents(raw: FormDataEntryValue | null): number | null {
  const s = String(raw ?? '').replace(/r\$/i, '').replace(/\s/g, '');
  if (!s) return 0;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? Math.round(n * 100) : null;
}

function outdatedMessage(version: string | null) {
  return `O PC do bar está com o RupBar ${version ?? 'antigo'}, que ainda não recebe ações do site. Instale a atualização no PC do bar e tente de novo.`;
}

/**
 * Envia a ação como comando para o PC do bar (fonte da verdade): ele confere,
 * aplica uma única vez e devolve "aplicado" ou o motivo da recusa.
 */
async function send(type: Exclude<RemoteCommandType, 'loss.register'>, payload: Record<string, unknown>, path: string): Promise<ActionState> {
  const { sb, est } = await currentEstablishment();
  if (!est) return { ok: false, message: 'Nenhum estabelecimento vinculado.' };
  // O PC antigo recusa na hora o que não conhece: avisa antes de enviar.
  const device = await deviceStatus(est.id);
  if (device && !versionAtLeast(device.app_version, OWNER_ACTIONS_VERSION)) return { ok: false, message: outdatedMessage(device.app_version) };
  const { error } = await sb.rpc('rupbar_owner_command', { p_establishment_id: est.id, p_type: type, p_payload: payload });
  if (error) return { ok: false, message: error.message };
  revalidatePath(path);
  return { ok: true, message: WAIT };
}

// ---------------------------------------------------------------- comandas

export async function openComanda(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const customerName = String(form.get('customerName') ?? '').trim().slice(0, 80);
  const cardRaw = String(form.get('cardNumber') ?? '').trim();
  const table = String(form.get('table') ?? '').trim().slice(0, 20);
  const cardNumber = cardRaw ? Number(cardRaw) : null;
  if (cardNumber !== null && (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 99_999)) return { ok: false, message: 'Número do cartão inválido.' };
  if (!customerName && cardNumber === null && !table) return { ok: false, message: 'Informe o nome, o cartão ou a mesa.' };
  const label = [cardNumber ? `Cartão ${cardNumber}` : null, customerName || null, table ? `mesa ${table}` : null].filter(Boolean).join(' · ');
  return send('comanda.open', { customerName, cardNumber, table: table || null, label }, '/comandas');
}

export async function launchItems(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const comandaId = String(form.get('comandaId') ?? '');
  const comandaLabel = String(form.get('comandaLabel') ?? '').slice(0, 40);
  if (!UUID.test(comandaId)) return { ok: false, message: 'Comanda inválida.' };
  let items: { presentationId: string; quantity: number; name?: string }[] = [];
  try {
    items = JSON.parse(String(form.get('items') ?? '[]'));
  } catch {
    return { ok: false, message: 'Itens inválidos.' };
  }
  items = items.filter((i) => UUID.test(i.presentationId) && Number.isInteger(i.quantity) && i.quantity >= 1 && i.quantity <= 99).slice(0, 30);
  if (!items.length) return { ok: false, message: 'Escolha ao menos um item.' };
  const label = `${comandaLabel}: ${items.map((i) => `${i.quantity}× ${String(i.name ?? 'item').slice(0, 40)}`).join(', ')}`.slice(0, 300);
  return send('order.create', { comandaId, items: items.map((i) => ({ presentationId: i.presentationId, quantity: i.quantity })), label }, '/comandas');
}

export async function cancelItem(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const itemId = String(form.get('itemId') ?? '');
  const reason = String(form.get('reason') ?? '').trim().slice(0, 200);
  if (!UUID.test(itemId)) return { ok: false, message: 'Item inválido.' };
  if (reason.length < 3) return { ok: false, message: 'Informe o motivo (ex.: lançado errado).' };
  return send('comanda_item.cancel', { itemId, reason, label: `Tirar ${String(form.get('itemLabel') ?? 'item').slice(0, 80)}` }, '/comandas');
}

// ------------------------------------------------------------------- caixa

export async function openCash(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const value = cents(form.get('openingBalance'));
  if (value === null) return { ok: false, message: 'Valor de troco inválido.' };
  return send('cash.open', { openingBalanceCents: value, label: `Abrir caixa com R$ ${(value / 100).toFixed(2).replace('.', ',')} de troco` }, '/caixas');
}

export async function closeCash(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const value = cents(form.get('countedCash'));
  if (value === null || !String(form.get('countedCash') ?? '').trim()) return { ok: false, message: 'Informe quanto tem em dinheiro na gaveta.' };
  const notes = String(form.get('notes') ?? '').trim().slice(0, 400);
  return send('cash.close', { countedCashCents: value, notes: notes || null, label: `Fechar caixa com R$ ${(value / 100).toFixed(2).replace('.', ',')} contados` }, '/caixas');
}

// ------------------------------------------------------ equipe e produtos

export async function removeUser(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const userId = String(form.get('userId') ?? '');
  if (!UUID.test(userId)) return { ok: false, message: 'Funcionário inválido.' };
  return send('user.remove', { userId, label: `Excluir ${String(form.get('name') ?? 'funcionário').slice(0, 80)}` }, '/equipe');
}

export async function setProductActive(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const productId = String(form.get('productId') ?? '');
  const active = form.get('active') === '1';
  if (!UUID.test(productId)) return { ok: false, message: 'Produto inválido.' };
  const name = String(form.get('name') ?? 'produto').slice(0, 80);
  return send('product.set_active', { productId, active, label: active ? `Voltar à venda: ${name}` : `Tirar da venda: ${name}` }, '/produtos');
}

/** Cancela uma ação que o PC ainda não recebeu. */
export async function cancelCommand(form: FormData): Promise<void> {
  const { sb } = await currentEstablishment();
  await sb.rpc('rupbar_owner_cancel_command', { p_command_id: String(form.get('id') ?? '') });
  revalidatePath(String(form.get('path') ?? '/'));
}
