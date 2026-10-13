/**
 * Código interno automático dos produtos (0001, 0002…).
 *
 * A sequência 'product_code' guarda o último número emitido; o próximo código
 * pula os que já estão em uso (inclusive digitados à mão, como "7" ou "0012"),
 * respeitando o índice único products.internal_code.
 */
import { nextProductCode } from '@rupbar/core';
import type { Db } from './db';

const SEQ = 'product_code';

function takenCodes(db: Db): string[] {
  return db.all<{ internal_code: string }>('SELECT internal_code FROM products WHERE internal_code IS NOT NULL').map((r) => r.internal_code);
}

function lastIssued(db: Db): number {
  return db.value<number>('SELECT value FROM sequences WHERE name = ?', SEQ) ?? 0;
}

function saveLast(db: Db, seq: number): void {
  db.run('INSERT INTO sequences(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', SEQ, seq);
}

/** Próximo código, sem reservá-lo (prévia na tela de cadastro). */
export function peekProductCode(db: Db): string {
  return nextProductCode(takenCodes(db), lastIssued(db)).code;
}

/** Reserva e devolve o próximo código livre. Chamar dentro da transação que grava o produto. */
export function allocateProductCode(db: Db): string {
  const next = nextProductCode(takenCodes(db), lastIssued(db));
  saveLast(db, next.seq);
  return next.code;
}

/**
 * Preenche o código dos produtos que ainda não têm, na ordem de cadastro.
 * Usado pela migração 6; devolve quantos produtos receberam código.
 */
export function backfillProductCodes(db: Db, nowIso: string): number {
  const pending = db.all<{ id: string }>(
    "SELECT id FROM products WHERE internal_code IS NULL OR trim(internal_code) = '' ORDER BY created_at, id",
  );
  if (!pending.length) return 0;
  const taken = takenCodes(db).filter((c) => c.trim() !== '');
  let last = lastIssued(db);
  for (const p of pending) {
    const next = nextProductCode(taken, last);
    db.run('UPDATE products SET internal_code = ?, version = version + 1, updated_at = ? WHERE id = ?', next.code, nowIso, p.id);
    taken.push(next.code);
    last = next.seq;
  }
  saveLast(db, last);
  return pending.length;
}
