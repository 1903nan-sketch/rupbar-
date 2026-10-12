import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hash de senha com scrypt (memória-intensivo, nativo do Node, sem módulos
 * nativos extras). Formato: scrypt$N$r$p$salt$hash (base64url).
 */
let N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Somente para testes: reduz o custo do scrypt. */
export function setPasswordHashCost(n: number): void {
  N = n;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash fixo usado para equalizar o tempo de resposta quando o e-mail não existe. */
let dummyHash: string | null = null;
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= await hashPassword('rupbar-dummy-password-1');
  await verifyPassword(password, dummyHash);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Código numérico (pareamento da TV). */
export function numericCode(digits = 6): string {
  return Array.from({ length: digits }, () => randomInt(0, 10)).join('');
}

/**
 * Senha temporária legível para ditar ao funcionário (sem caracteres ambíguos).
 * Ex.: "kmr4-8tpx-2w"
 */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = (n: number) => Array.from({ length: n }, () => alphabet[randomInt(0, alphabet.length)]).join('');
  let pwd = '';
  do pwd = `${pick(4)}-${pick(4)}-${pick(2)}`;
  while (!/\d/.test(pwd) || !/[a-z]/.test(pwd));
  return pwd;
}

/**
 * Cofre de segredos (credenciais do WhatsApp, segredo do dispositivo na nuvem).
 * AES-256-GCM com chave mestra guardada em arquivo no diretório de dados, que
 * o instalador protege com ACL (somente SYSTEM e Administradores).
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Chave mestra deve ter 32 bytes');
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
  }

  open(sealed: string): string {
    const [v, ivB, tagB, encB] = sealed.split('.');
    if (v !== 'v1' || !ivB || !tagB || encB === undefined) throw new Error('Segredo em formato inválido');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encB, 'base64url')), decipher.final()]).toString('utf8');
  }
}
