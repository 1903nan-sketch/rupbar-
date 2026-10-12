/**
 * Dinheiro é sempre representado em centavos inteiros (number seguro até 2^53).
 * Nunca usar ponto flutuante para valores monetários.
 */

export type Cents = number;

export function assertCents(value: number, field = 'valor'): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${field} deve ser um número inteiro de centavos`);
  }
  return value;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 12345 -> "R$ 123,45" */
export function formatBRL(cents: Cents): string {
  // Intl usa espaço não separável; normalizamos para espaço comum (impressão térmica).
  return brl.format(cents / 100).replace(/ /g, ' ');
}

/**
 * Converte texto digitado pelo usuário em centavos.
 * Aceita "12,50", "12.50", "R$ 1.234,56", "1234", "-3,5".
 */
export function parseBRL(input: string): Cents | null {
  let s = input.trim().replace(/R\$\s?/i, '').replace(/\s/g, '');
  if (!s) return null;
  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart: string;
  let decPart = '';
  if (lastComma >= 0 && lastComma > lastDot) {
    intPart = s.slice(0, lastComma).replace(/\./g, '');
    decPart = s.slice(lastComma + 1);
  } else if (lastDot >= 0 && lastComma < 0 && s.length - lastDot - 1 <= 2 && s.indexOf('.') === lastDot) {
    // "12.5" ou "12.50" (decimal com ponto); "1.234" é tratado como milhar abaixo
    intPart = s.slice(0, lastDot);
    decPart = s.slice(lastDot + 1);
  } else {
    intPart = s.replace(/[.,]/g, '');
  }
  if (decPart.length > 2 || !/^\d*$/.test(intPart) || !/^\d*$/.test(decPart)) return null;
  const cents = Number(intPart || '0') * 100 + Number(decPart.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Percentual em pontos-base (1% = 100 bp) aplicado com arredondamento bancário. */
export function applyBasisPoints(cents: Cents, bp: number): Cents {
  return roundHalfEven((cents * bp) / 10_000);
}

export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) return floor + 1;
  if (diff < 0.5 - EPS) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Divide um valor em N partes iguais sem perder centavos.
 * O resto é distribuído um centavo por vez nas primeiras partes.
 */
export function splitEqually(total: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError('Número de partes inválido');
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function sum(values: readonly number[]): number {
  let t = 0;
  for (const v of values) t += v;
  return t;
}
