'use server';
import { PAYMENT_METHODS, type PaymentMethod, type RemoteCommandType } from '@rupbar/core';
import { revalidatePath } from 'next/cache';
import { currentEstablishment } from '@/lib/data';

export interface ActionState {
  ok: boolean;
  message: string;
}

const UUID = /^[0-9a-f-]{36}$/;
const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
const WAIT = 'Enviado. O PC do bar aplica em alguns segundos (veja em "Ações enviadas").';

/** Valor em reais digitado ("1.234,56", "50") → centavos; null se inválido. */
function cents(raw: FormDataEntryValue | null): number | null {
  const s = String(raw ?? '').replace(/r\$/i, '').replace(/\s/g, '');
  if (!s) return 0;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? Math.round(n * 100) : null;
}

/**
 * Envia a ação como comando para o PC do bar (fonte da verdade): ele confere,
 * aplica uma única vez e devolve "aplicado" ou o motivo da recusa.
 */
async function send(type: Exclude<RemoteCommandType, 'loss.register'>, payload: Record<string, unknown>, path: string): Promise<ActionState> {
  const { sb, est } = await currentEstablishment();
  if (!est) return { ok: false, message: 'Nenhum estabelecimento vinculado.' };
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

/**
 * Encerrar pelo painel: recebe o que falta (uma ou mais formas) e encerra. O PC
 * confere o saldo de novo; se a comanda mudou, recusa e nada é registrado.
 */
export async function closeComanda(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const comandaId = String(form.get('comandaId') ?? '');
  const comandaLabel = String(form.get('comandaLabel') ?? 'comanda').slice(0, 40);
  const due = Number(form.get('remainingCents') ?? 0);
  if (!UUID.test(comandaId)) return { ok: false, message: 'Comanda inválida.' };
  let raw: { method?: string; amountCents?: number }[] = [];
  try {
    raw = JSON.parse(String(form.get('payments') ?? '[]'));
  } catch {
    return { ok: false, message: 'Pagamentos inválidos.' };
  }
  if (!Array.isArray(raw) || raw.length > 10) return { ok: false, message: 'Pagamentos inválidos.' };
  const payments = raw.map((p) => ({ method: String(p.method) as PaymentMethod, amountCents: Number(p.amountCents) }));
  if (payments.some((p) => !(p.method in PAYMENT_METHODS) || !Number.isInteger(p.amountCents) || p.amountCents <= 0)) return { ok: false, message: 'Confira as formas de pagamento e os valores.' };
  const sum = payments.reduce((a, p) => a + p.amountCents, 0);
  if (!Number.isInteger(due) || sum !== due) return { ok: false, message: `A soma dos pagamentos (${brl(sum)}) tem de ser igual ao que falta (${brl(due)}).` };
  const how = payments.map((p) => `${PAYMENT_METHODS[p.method]} ${brl(p.amountCents)}`).join(' + ');
  const r = await send('comanda.close', { comandaId, payments, label: `Encerrar ${comandaLabel}${how ? `: ${how}` : ''}` }, '/comandas');
  return r.ok ? { ok: true, message: 'Enviado. O PC do bar recebe o pagamento e encerra em alguns segundos (veja em "Ações enviadas").' } : r;
}

// --------------------------------------------------------------- descontos

/** Desconto direto na comanda (só o proprietário dá desconto). "10%" vale sobre os itens. */
export async function giveDiscount(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const comandaId = String(form.get('comandaId') ?? '');
  const comandaLabel = String(form.get('comandaLabel') ?? 'comanda').slice(0, 40);
  const reason = String(form.get('reason') ?? '').trim().slice(0, 200);
  const subtotal = Number(form.get('subtotalCents') ?? 0);
  if (!UUID.test(comandaId)) return { ok: false, message: 'Comanda inválida.' };
  const raw = String(form.get('value') ?? '').trim();
  let value: number | null;
  if (raw.endsWith('%')) {
    const pct = Number(raw.slice(0, -1).replace(',', '.'));
    value = Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round((subtotal * pct) / 100) : null;
  } else value = cents(raw);
  if (value === null) return { ok: false, message: 'Valor do desconto inválido (ex.: 15,00 ou 10%).' };
  if (value > subtotal) return { ok: false, message: 'O desconto é maior que o valor dos itens.' };
  if (value > 0 && reason.length < 3) return { ok: false, message: 'Informe o motivo do desconto.' };
  const label = value ? `${comandaLabel}: desconto de ${brl(value)}` : `${comandaLabel}: tirar o desconto`;
  return send('comanda.discount', { comandaId, discountCents: value, reason: value ? reason : 'Desconto tirado', label }, '/comandas');
}

/** Resposta a um pedido de desconto feito por um funcionário no PC. */
export async function decideDiscount(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const requestId = String(form.get('requestId') ?? '');
  const approve = form.get('decision') === 'approve';
  const note = String(form.get('note') ?? '').trim().slice(0, 200) || null;
  if (!UUID.test(requestId)) return { ok: false, message: 'Pedido inválido.' };
  const label = String(form.get('label') ?? '').slice(0, 120);
  const r = await send(approve ? 'discount.approve' : 'discount.reject', { requestId, note, label: `${approve ? 'Aceitar' : 'Recusar'} ${label}` }, '/comandas');
  return r.ok ? { ok: true, message: approve ? 'Aceito. O PC do bar aplica o desconto em alguns segundos e avisa quem pediu.' : 'Recusado. Quem pediu recebe o aviso no PC.' } : r;
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
