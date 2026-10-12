/**
 * Identificadores únicos ordenáveis por tempo (UUID v7, RFC 9562).
 *
 * Gerados localmente em qualquer dispositivo, sem coordenação central, o que
 * permite criar registros offline e sincronizá-los depois sem colisões.
 * A ordenação temporal mantém os índices do SQLite/Postgres compactos.
 */

let lastMs = 0;
let seq = 0;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function uuidv7(now: number = Date.now()): string {
  // Garante monotonicidade dentro do mesmo milissegundo (12 bits de sequência).
  if (now <= lastMs) {
    seq++;
    if (seq > 0xfff) {
      lastMs++;
      seq = 0;
    }
    now = lastMs;
  } else {
    lastMs = now;
    seq = 0;
  }
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Extrai o instante (ms) de um UUID v7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
