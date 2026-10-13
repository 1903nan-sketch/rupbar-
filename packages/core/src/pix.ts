/**
 * Pix "copia e cola" estático (BR Code), conforme o Manual de Padrões para
 * Iniciação do Pix do Banco Central (EMV® QRCPS-MPM).
 *
 * O código é montado localmente, sem PSP nem internet: o cliente lê o QR (ou
 * cola o texto) no app do banco e paga direto na chave do bar. Por ser
 * estático, o RupBar NÃO recebe confirmação automática — quem recebe confere o
 * crédito no app do banco antes de registrar o pagamento.
 *
 * Estrutura (TLV: ID de 2 dígitos + tamanho de 2 dígitos + valor):
 *   00 Payload Format Indicator ("01")
 *   26 Merchant Account Information — Pix
 *       00 GUI "br.gov.bcb.pix" · 01 chave · 02 descrição (opcional)
 *   52 Merchant Category Code ("0000")
 *   53 Moeda ("986" = BRL)
 *   54 Valor (opcional, "12.34")
 *   58 País ("BR")
 *   59 Nome do recebedor (até 25)
 *   60 Cidade (até 15)
 *   62 Additional Data Field — 05 txid (até 25 alfanuméricos ou "***")
 *   63 CRC16/CCITT-FALSE de todo o conteúdo, incluindo "6304"
 */

import { isValidCnpj, isValidCpf, isValidEmail, normalizePhoneBR, onlyDigits } from './validators';

export const PIX_KEY_TYPES = {
  cnpj: 'CNPJ',
  cpf: 'CPF',
  phone: 'Celular',
  email: 'E-mail',
  random: 'Chave aleatória',
} as const;
export type PixKeyType = keyof typeof PIX_KEY_TYPES;

export const PIX_GUI = 'br.gov.bcb.pix';
export const PIX_NAME_MAX = 25;
export const PIX_CITY_MAX = 15;
export const PIX_TXID_MAX = 25;
/** Tamanho máximo de uma chave Pix (e-mail: 77 caracteres). */
export const PIX_KEY_MAX = 77;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PixKeyCheck = { ok: true; key: string } | { ok: false; error: string };

/**
 * Normaliza e valida a chave conforme o tipo, no formato registrado no DICT:
 * CPF/CNPJ só dígitos, celular "+55DDDNÚMERO", e-mail minúsculo e chave
 * aleatória (EVP) como UUID minúsculo com hífens.
 */
export function normalizePixKey(type: PixKeyType, input: string): PixKeyCheck {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, error: 'Informe a chave Pix.' };
  switch (type) {
    case 'cpf':
      return isValidCpf(raw) && /^[\d.\-\s]+$/.test(raw) ? { ok: true, key: onlyDigits(raw) } : { ok: false, error: 'CPF inválido.' };
    case 'cnpj':
      return isValidCnpj(raw) && /^[\d./\-\s]+$/.test(raw) ? { ok: true, key: onlyDigits(raw) } : { ok: false, error: 'CNPJ inválido.' };
    case 'phone': {
      if (!/^[\d()+\-.\s]+$/.test(raw)) return { ok: false, error: 'Celular inválido (use DDD + número).' };
      const n = normalizePhoneBR(raw);
      // Chave Pix de telefone é sempre celular: DDD + 9 dígitos começando por 9.
      if (!n || n.length !== 11) return { ok: false, error: 'Celular inválido: use DDD + 9 dígitos (ex.: (11) 98765-4321).' };
      return { ok: true, key: `+55${n}` };
    }
    case 'email': {
      const e = raw.toLowerCase();
      if (!/^[\x21-\x7e]+$/.test(e) || !isValidEmail(e)) return { ok: false, error: 'E-mail inválido.' };
      if (e.length > PIX_KEY_MAX) return { ok: false, error: `E-mail muito longo para chave Pix (máximo ${PIX_KEY_MAX} caracteres).` };
      return { ok: true, key: e };
    }
    case 'random': {
      let k = raw.toLowerCase().replace(/\s/g, '');
      // Aceita a chave colada sem hífens (32 caracteres hexadecimais).
      if (/^[0-9a-f]{32}$/.test(k)) k = `${k.slice(0, 8)}-${k.slice(8, 12)}-${k.slice(12, 16)}-${k.slice(16, 20)}-${k.slice(20)}`;
      return UUID_RE.test(k) ? { ok: true, key: k } : { ok: false, error: 'Chave aleatória inválida (formato 123e4567-e89b-12d3-a456-426614174000).' };
    }
    default:
      return { ok: false, error: 'Tipo de chave inválido.' };
  }
}

/**
 * Texto aceito nos campos de nome/cidade/descrição: remove acentos ("São" →
 * "Sao"), descarta caracteres que alguns apps de banco rejeitam, compacta
 * espaços e trunca. Mantém maiúsculas/minúsculas como digitado.
 */
export function sanitizePixText(input: string | null | undefined, max: number): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-&'/]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Identificador da transação: até 25 alfanuméricos; vazio vira "***" (sem identificador). */
export function sanitizeTxid(input: string | null | undefined): string {
  const t = (input ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, PIX_TXID_MAX);
  return t || '***';
}

/** txid de uma comanda ("RB123"): identifica o pagamento no extrato do banco. */
export function comandaPixTxid(comandaNumber: number): string {
  return sanitizeTxid(`RB${comandaNumber}`);
}

/** 1234 centavos → "12.34" (sem ponto flutuante). */
export function formatPixAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Valor Pix inválido');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Campo TLV do EMV: ID + tamanho com 2 dígitos + valor (até 99 caracteres). */
export function emvField(id: string, value: string): string {
  if (!/^\d{2}$/.test(id)) throw new RangeError(`ID EMV inválido: ${id}`);
  if (value.length > 99) throw new RangeError(`Campo ${id} excede 99 caracteres`);
  return id + String(value.length).padStart(2, '0') + value;
}

/** CRC16/CCITT-FALSE (polinômio 0x1021, valor inicial 0xFFFF), 4 dígitos hexadecimais maiúsculos. */
export function crc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= (input.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface PixPayloadInput {
  /** Chave já normalizada (ver normalizePixKey). */
  key: string;
  merchantName: string;
  merchantCity: string;
  /** Em centavos; omitido ou 0 = o cliente digita o valor no app. */
  amountCents?: number | null;
  txid?: string | null;
  description?: string | null;
}

/** Monta o Pix copia e cola estático (o mesmo texto vai no QR Code). */
export function buildPixPayload(input: PixPayloadInput): string {
  const key = input.key.trim();
  if (!key) throw new RangeError('Chave Pix não informada');
  if (key.length > PIX_KEY_MAX) throw new RangeError('Chave Pix muito longa');
  const name = sanitizePixText(input.merchantName, PIX_NAME_MAX);
  const city = sanitizePixText(input.merchantCity, PIX_CITY_MAX);
  if (!name) throw new RangeError('Nome do recebedor não informado');
  if (!city) throw new RangeError('Cidade do recebedor não informada');

  let account = emvField('00', PIX_GUI) + emvField('01', key);
  // A descrição só entra se couber no limite de 99 caracteres do campo 26.
  const room = 99 - account.length - 4;
  const description = room > 0 ? sanitizePixText(input.description, room) : '';
  if (description) account += emvField('02', description);

  const amount = input.amountCents && input.amountCents > 0 ? emvField('54', formatPixAmount(input.amountCents)) : '';
  const body =
    emvField('00', '01') +
    emvField('26', account) +
    emvField('52', '0000') +
    emvField('53', '986') +
    amount +
    emvField('58', 'BR') +
    emvField('59', name) +
    emvField('60', city) +
    emvField('62', emvField('05', sanitizeTxid(input.txid))) +
    '6304';
  return body + crc16Ccitt(body);
}

export interface EmvNode {
  id: string;
  value: string;
}

/** Lê os campos TLV de primeiro nível (útil para conferência e testes). */
export function parseEmv(payload: string): EmvNode[] {
  const out: EmvNode[] = [];
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(payload.slice(i + 2, i + 4)) || i + 4 + len > payload.length) {
      throw new RangeError(`BR Code malformado na posição ${i}`);
    }
    out.push({ id, value: payload.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

/** Confere estrutura e CRC de um Pix copia e cola. */
export function isValidPixPayload(payload: string): boolean {
  if (payload.length < 8 || payload.slice(-8, -4) !== '6304') return false;
  try {
    parseEmv(payload);
  } catch {
    return false;
  }
  return crc16Ccitt(payload.slice(0, -4)) === payload.slice(-4).toUpperCase();
}
