/**
 * Cliente da API local. Mesmo domínio do servidor (PC do bar), com cookie de
 * sessão HttpOnly e cabeçalho anti-CSRF em toda alteração.
 */
import { uuidv7 } from '@rupbar/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
export function onAuthError(fn: Listener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

export const isOfflineError = (e: unknown) => e instanceof ApiError && e.code === 'NETWORK';

async function request<T>(method: string, url: string, body?: unknown, opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-rupbar': '1' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o PC do bar. Verifique o Wi-Fi.');
  }
  if (!res.ok) {
    let code = 'HTTP_' + res.status;
    let message = 'Não foi possível concluir a operação.';
    let details: unknown;
    try {
      const j = (await res.json()) as { error?: { code: string; message: string; details?: unknown } };
      if (j.error) ({ code, message, details } = j.error);
    } catch {
      /* resposta sem JSON */
    }
    const e = new ApiError(res.status, code, message, details);
    if (res.status === 401 || code === 'PASSWORD_CHANGE_REQUIRED') authListeners.forEach((l) => l(e));
    throw e;
  }
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  get: <T = any>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, { signal }),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T = any>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  upload: <T = any>(url: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<T>('POST', url, fd);
  },
};

/** Identificador de idempotência gerado no dispositivo. */
export const requestId = () => uuidv7();

export function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
