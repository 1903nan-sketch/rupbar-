/**
 * Validação e minimização de dados pessoais (LGPD).
 * CPF e telefone são opcionais na maior parte dos fluxos; quando coletados,
 * devem ser exibidos mascarados e nunca impressos ou enviados à TV.
 */

export function onlyDigits(s: string): string {
  return s.replace(/\D/g, '');
}

export function isValidCpf(input: string): boolean {
  const cpf = onlyDigits(input);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digits = cpf.split('').map(Number);
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i]! * (len + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== digits[len]) return false;
  }
  return true;
}

export function isValidCnpj(input: string): boolean {
  const cnpj = onlyDigits(input);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const digits = cnpj.split('').map(Number);
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i]! * weights[i]!;
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === digits[12] && calc(13) === digits[13];
}

/** Telefone brasileiro: 10 (fixo) ou 11 (celular) dígitos com DDD, opcional +55. */
export function normalizePhoneBR(input: string): string | null {
  let d = onlyDigits(input);
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (d.length === 11 && d[2] !== '9') return null;
  return d;
}

export function formatPhoneBR(digits: string): string {
  const d = onlyDigits(digits);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return digits;
}

/** E.164 para integrações (WhatsApp). */
export function phoneToE164(digits: string): string | null {
  const n = normalizePhoneBR(digits);
  return n ? `+55${n}` : null;
}

export function formatCpf(cpf: string): string {
  const d = onlyDigits(cpf);
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : cpf;
}

export function formatCnpj(cnpj: string): string {
  const d = onlyDigits(cnpj);
  return d.length === 14
    ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
    : cnpj;
}

/** "***.456.789-**" — padrão de mascaramento usado em telas e relatórios. */
export function maskCpf(cpf: string | null | undefined): string {
  const d = onlyDigits(cpf ?? '');
  if (d.length !== 11) return '';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

/** "(11) *****-4321" */
export function maskPhone(phone: string | null | undefined): string {
  const d = onlyDigits(phone ?? '');
  if (d.length < 10) return '';
  return `(${d.slice(0, 2)}) *****-${d.slice(-4)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email.trim());
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Primeiro nome, para painel de retirada e cupons (minimização de dados). */
export function firstName(fullName: string | null | undefined): string {
  const n = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return n.slice(0, 24);
}

/** Nome para chamar na TV/produção: "Carlos Alberto Silva" → "Carlos S." (sem expor o nome completo). */
export function displayName(fullName: string | null | undefined): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0]!.slice(0, 18);
  const lastWord = parts.length > 1 ? parts[parts.length - 1]! : '';
  return lastWord && !['de', 'da', 'do', 'das', 'dos'].includes(lastWord.toLowerCase()) ? `${first} ${lastWord[0]!.toUpperCase()}.` : first;
}

/** Iniciais para o placeholder de logotipo: "Bar do Zé" → "BZ". */
export function initials(name: string): string {
  const stop = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'the', '&']);
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !stop.has(w.toLowerCase()));
  if (words.length === 0) return 'RB';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/** Política de senha: mínimo 8 caracteres, letras e números, não trivial. */
export function checkPasswordStrength(password: string, context: string[] = []): PasswordCheck {
  const problems: string[] = [];
  if (password.length < 8) problems.push('Use pelo menos 8 caracteres.');
  if (password.length > 128) problems.push('Use no máximo 128 caracteres.');
  if (!/[a-zA-Z]/.test(password)) problems.push('Inclua ao menos uma letra.');
  if (!/\d/.test(password)) problems.push('Inclua ao menos um número.');
  const lower = password.toLowerCase();
  const common = ['12345678', 'password', 'senha123', 'qwerty12', 'abc12345', 'rupbar123', '11111111'];
  if (common.some((c) => lower.includes(c))) problems.push('Senha muito comum.');
  for (const c of context) {
    const token = c.toLowerCase().split('@')[0] ?? '';
    if (token.length >= 4 && lower.includes(token)) {
      problems.push('Não use seu nome ou e-mail na senha.');
      break;
    }
  }
  return { ok: problems.length === 0, problems };
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}
