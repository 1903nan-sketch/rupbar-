import { evolutionStatus, formatPhoneBR, type EvolutionRawState, type WaConnectionStatus } from '@rupbar/core';
import type { HttpSender } from './notifications';

/**
 * Cliente mínimo da Evolution API (v2, com compatibilidade com a v1).
 * Autenticação pelo cabeçalho `apikey` (chave global ou token da instância).
 * Todos os erros viram EvolutionError com mensagem em português para o proprietário.
 */

export interface EvolutionCredentials {
  /** Sem barra final (ex.: https://evo.exemplo.com). */
  baseUrl: string;
  apiKey: string;
  instance: string;
}

export type EvolutionErrorKind = 'unreachable' | 'timeout' | 'unauthorized' | 'not_found' | 'bad_url' | 'invalid_response' | 'upstream';

export class EvolutionError extends Error {
  constructor(
    readonly kind: EvolutionErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface EvolutionQr {
  /** Imagem pronta (data:image/png;base64,...), quando a Evolution envia. */
  base64: string | null;
  /** Conteúdo do QR (a interface desenha se não houver imagem). */
  code: string | null;
  /** Código para "Conectar com número de telefone" no WhatsApp. */
  pairingCode: string | null;
}

export interface EvolutionState {
  state: EvolutionRawState | null;
  status: WaConnectionStatus;
}

interface Reply {
  status: number;
  ok: boolean;
  /** undefined = corpo não é JSON (ex.: página HTML de outro site). */
  json: unknown;
  text: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Junta as mensagens de erro da Evolution ({ response: { message: [...] } }, { message }, { error }). */
export function evolutionMessage(json: unknown): string {
  if (!isObj(json)) return '';
  const resp = isObj(json.response) ? json.response : null;
  const raw = resp?.message ?? json.message ?? json.error;
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((m) => (typeof m === 'string' ? m : isObj(m) ? JSON.stringify(m) : ''))
    .filter(Boolean)
    .join('; ')
    .slice(0, 300);
}

const INSTANCE_MISSING_RE = /does not exist|não existe|not found instance|instance not found/i;
const ALREADY_EXISTS_RE = /already in use|already exists|já existe|já está em uso/i;
const NOT_CONNECTED_RE = /not connected|não está conectad|is not open|closed/i;

export class EvolutionClient {
  constructor(
    private readonly http: HttpSender,
    private readonly c: EvolutionCredentials,
  ) {}

  private get host(): string {
    try {
      return new URL(this.c.baseUrl).host;
    } catch {
      return this.c.baseUrl;
    }
  }

  private get inst(): string {
    return encodeURIComponent(this.c.instance);
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Reply> {
    let res: Awaited<ReturnType<HttpSender>>;
    try {
      res = await this.http(`${this.c.baseUrl}${path}`, {
        method,
        headers: { apikey: this.c.apiKey, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new EvolutionError('timeout', `A Evolution API em ${this.host} não respondeu a tempo. Verifique se o servidor está ligado e tente de novo.`);
      }
      throw new EvolutionError(
        'unreachable',
        `Não foi possível falar com a Evolution API em ${this.host}. Confira o endereço e se este PC tem internet (ou acesso à rede do servidor).`,
      );
    }
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  /** Converte uma resposta de erro em mensagem clara. */
  private fail(r: Reply): EvolutionError {
    const msg = evolutionMessage(r.json);
    if (r.status === 401 || r.status === 403) {
      return new EvolutionError(
        'unauthorized',
        r.status === 401
          ? 'A chave da API (apikey) foi recusada pela Evolution. Confira se copiou a chave completa, sem espaços.'
          : 'A chave da API não tem permissão para esta ação. Use a chave global da Evolution (AUTHENTICATION_API_KEY).',
        r.status,
      );
    }
    if (r.status === 404) {
      if (INSTANCE_MISSING_RE.test(msg)) {
        return new EvolutionError('not_found', `A instância “${this.c.instance}” não existe nesta Evolution. Use “Criar instância”.`, 404);
      }
      return new EvolutionError('bad_url', `Endereço não encontrado em ${this.host}. Confira se é o endereço da Evolution API (sem caminhos extras).`, 404);
    }
    if (r.json === undefined) {
      return new EvolutionError('invalid_response', `${this.host} respondeu, mas não parece ser uma Evolution API (erro ${r.status}). Confira o endereço.`, r.status);
    }
    if (r.status >= 500) {
      return new EvolutionError('upstream', `A Evolution API está com problema (erro ${r.status})${msg ? `: ${msg}` : ''}. Tente novamente em instantes.`, r.status);
    }
    return new EvolutionError('upstream', `A Evolution API recusou o pedido (erro ${r.status})${msg ? `: ${msg}` : ''}.`, r.status);
  }

  private body(r: Reply): Obj | unknown[] {
    if (!isObj(r.json) && !Array.isArray(r.json)) {
      throw new EvolutionError('invalid_response', `${this.host} respondeu, mas não parece ser uma Evolution API. Confira o endereço.`, r.status);
    }
    return r.json;
  }

  /** Estado da conexão do WhatsApp da instância. */
  async connectionState(): Promise<EvolutionState> {
    const r = await this.call('GET', `/instance/connectionState/${this.inst}`);
    if (!r.ok) {
      const e = this.fail(r);
      if (e.kind === 'not_found') return { state: null, status: 'not_found' };
      throw e;
    }
    const j = this.body(r) as Obj;
    // v2: { instance: { instanceName, state } } · algumas versões: { state }
    const raw = str(isObj(j.instance) ? j.instance.state : undefined) ?? str(j.state);
    if (!raw) throw new EvolutionError('invalid_response', `${this.host} respondeu, mas não informou o estado da instância. Confira o endereço.`, r.status);
    return { state: raw as EvolutionRawState, status: evolutionStatus(raw) };
  }

  /** Cria a instância (Baileys, com QR). Se já existir, não é erro. */
  async create(): Promise<{ created: boolean; qr: EvolutionQr | null }> {
    const body = { instanceName: this.c.instance, qrcode: true, integration: 'WHATSAPP-BAILEYS' };
    let r = await this.call('POST', '/instance/create', body);
    // A v1 não conhece o campo "integration".
    if (r.status === 400 && !ALREADY_EXISTS_RE.test(evolutionMessage(r.json))) {
      r = await this.call('POST', '/instance/create', { instanceName: this.c.instance, qrcode: true });
    }
    if (r.ok) {
      const j = this.body(r) as Obj;
      return { created: true, qr: parseQr(j.qrcode) };
    }
    if ([400, 403, 409].includes(r.status) && ALREADY_EXISTS_RE.test(evolutionMessage(r.json))) return { created: false, qr: null };
    throw this.fail(r);
  }

  /** Pede o QR Code para conectar (ou informa que já está conectado). */
  async connect(): Promise<{ status: WaConnectionStatus; qr: EvolutionQr | null }> {
    const r = await this.call('GET', `/instance/connect/${this.inst}`);
    if (!r.ok) throw this.fail(r);
    const j = this.body(r) as Obj;
    const state = str(isObj(j.instance) ? j.instance.state : undefined) ?? str(j.state);
    if (state === 'open') return { status: 'connected', qr: null };
    return { status: 'waiting_qr', qr: parseQr(j) };
  }

  /** Desconecta o WhatsApp da instância (POST na maioria das versões; DELETE em outras). */
  async logout(): Promise<void> {
    let r = await this.call('POST', `/instance/logout/${this.inst}`);
    if (r.status === 404 || r.status === 405) {
      if (INSTANCE_MISSING_RE.test(evolutionMessage(r.json))) throw this.fail(r);
      r = await this.call('DELETE', `/instance/logout/${this.inst}`);
    }
    if (r.ok) return;
    // Já estava desconectado: o objetivo foi atingido.
    if (r.status === 400 && NOT_CONNECTED_RE.test(evolutionMessage(r.json))) return;
    throw this.fail(r);
  }

  /**
   * Envia texto. Formato v2: { number, text }. Se o servidor recusar com 400
   * (v1 espera { number, textMessage: { text } }), tenta uma vez no formato antigo.
   */
  async sendText(number: string, text: string): Promise<void> {
    const path = `/message/sendText/${this.inst}`;
    const r = await this.call('POST', path, { number, text });
    if (r.ok) return;
    if (r.status === 400) {
      if (/"exists"\s*:\s*false/.test(r.text)) {
        throw new EvolutionError('upstream', `O número ${formatPhoneBR(number.replace(/^55/, ''))} não tem WhatsApp. Confira o número do proprietário.`, 400);
      }
      const v1 = await this.call('POST', path, { number, textMessage: { text } });
      if (v1.ok) return;
      // Relata o erro original (formato atual), mais útil que o da tentativa antiga.
      throw this.fail(r);
    }
    throw this.fail(r);
  }

  /** Número e nome do WhatsApp conectado (melhor esforço; formatos v1 e v2). */
  async profile(): Promise<{ number: string | null; name: string | null }> {
    try {
      const r = await this.call('GET', `/instance/fetchInstances?instanceName=${this.inst}`);
      if (!r.ok) return { number: null, name: null };
      const list = Array.isArray(r.json) ? r.json : isObj(r.json) ? [r.json] : [];
      for (const item of list) {
        if (!isObj(item)) continue;
        const v1 = isObj(item.instance) ? item.instance : null;
        const name = str(item.name) ?? str(item.instanceName) ?? str(v1?.instanceName);
        if (name && name !== this.c.instance) continue;
        const owner = str(item.ownerJid) ?? str(item.owner) ?? str(v1?.owner);
        const digits = owner ? owner.split('@')[0]!.replace(/\D/g, '') : '';
        return { number: digits || null, name: str(item.profileName) ?? str(v1?.profileName) };
      }
    } catch {
      /* informação opcional */
    }
    return { number: null, name: null };
  }
}

/** Extrai o QR das respostas de /instance/connect e /instance/create. */
export function parseQr(v: unknown): EvolutionQr | null {
  if (!isObj(v)) return null;
  let base64 = str(v.base64);
  if (base64 && !base64.startsWith('data:')) base64 = /^[A-Za-z0-9+/=\s]+$/.test(base64) ? `data:image/png;base64,${base64.replace(/\s/g, '')}` : null;
  if (base64 && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(base64)) base64 = null;
  const code = str(v.code);
  const pairingCode = str(v.pairingCode);
  if (!base64 && !code && !pairingCode) return null;
  return { base64, code, pairingCode };
}
