'use server';
import { LOSS_REASONS, toMilli } from '@rupbar/core';
import { revalidatePath } from 'next/cache';
import { currentEstablishment } from '@/lib/data';

export interface ActionState {
  ok: boolean;
  message: string;
}

/** Registra a perda como comando para o PC do bar (aguarda aplicação). */
export async function registerLoss(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const { sb, est } = await currentEstablishment();
  if (!est) return { ok: false, message: 'Nenhum estabelecimento vinculado.' };
  const productId = String(form.get('productId') ?? '');
  const unit = String(form.get('unit') ?? 'un');
  const reason = String(form.get('reason') ?? '');
  const amount = Number(String(form.get('amount') ?? '').replace(/\./g, '').replace(',', '.'));
  const occurred = String(form.get('occurredAt') ?? '');
  const notes = String(form.get('notes') ?? '').slice(0, 400);
  if (!/^[0-9a-f-]{36}$/.test(productId)) return { ok: false, message: 'Selecione o produto.' };
  if (!(reason in LOSS_REASONS)) return { ok: false, message: 'Selecione o motivo.' };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: 'Informe uma quantidade maior que zero.' };
  let qty: number;
  try {
    qty = toMilli(amount, unit);
  } catch {
    return { ok: false, message: 'Unidade inválida.' };
  }
  const { error } = await sb.rpc('rupbar_owner_register_loss', {
    p_establishment_id: est.id, p_product_id: productId, p_qty: qty, p_unit: unit, p_reason: reason,
    p_occurred_at: occurred ? new Date(`${occurred}:00-03:00`).toISOString() : null, p_notes: notes || null,
  });
  if (error) return { ok: false, message: error.message };
  revalidatePath('/perdas');
  return { ok: true, message: 'Perda registrada. Ela será aplicada ao estoque quando o PC do bar sincronizar.' };
}

export async function cancelCommand(form: FormData): Promise<void> {
  const { sb } = await currentEstablishment();
  await sb.rpc('rupbar_owner_cancel_command', { p_command_id: String(form.get('id') ?? '') });
  revalidatePath('/perdas');
}
