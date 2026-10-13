import {
  backoffMs, formatBRL, formatQty, PAYMENT_METHODS, phoneToE164, phoneToWhatsApp, restockSuggestion,
  type CashClosingSummary, type Measure, type PaymentMethod,
} from '@rupbar/core';
import { evolutionCredentialsSchema, whatsappSchema, whatsappSendTestSchema } from '@rupbar/core/schemas';
import { AppError, badRequest } from '../lib/errors';
import { addMs } from '../lib/time';
import { requirePerm, type Actor, type Ctx } from './context';
import { EvolutionClient, EvolutionError, type EvolutionCredentials } from './evolution';
import type { SettingsService } from './settings';

const MAX_ATTEMPTS = 12;
const ALERT_TTL_MS = 24 * 3_600_000;

export type WhatsAppProvider = 'disabled' | 'meta' | 'twilio' | 'webhook' | 'evolution';

/** Configuração persistida: segredos sempre cifrados (SecretBox). */
interface StoredConfig {
  provider: WhatsAppProvider;
  ownerPhone: string | null;
  meta?: { phoneNumberId?: string; accessToken?: string; templateName?: string; templateLanguage?: string };
  twilio?: { accountSid?: string; authToken?: string; from?: string };
  webhook?: { url?: string; token?: string };
  evolution?: { baseUrl?: string; apiKey?: string; instance?: string };
  alerts?: { stockLow?: boolean; cashClosed?: boolean };
}

export type HttpSender = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Mesma origem (protocolo + host + porta): só então a chave salva pode ser reaproveitada. */
function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

const EVOLUTION_CODES = {
  unreachable: 'EVOLUTION_UNREACHABLE',
  timeout: 'EVOLUTION_UNREACHABLE',
  unauthorized: 'EVOLUTION_UNAUTHORIZED',
  not_found: 'EVOLUTION_INSTANCE_NOT_FOUND',
  bad_url: 'EVOLUTION_BAD_URL',
  invalid_response: 'EVOLUTION_BAD_URL',
  upstream: 'EVOLUTION_ERROR',
} as const;

/** Falhas da Evolution viram erros da API com código estável (nunca 401, que encerraria a sessão na tela). */
function toAppError(err: unknown): unknown {
  if (!(err instanceof EvolutionError)) return err;
  return new AppError(err.kind === 'not_found' ? 404 : 502, EVOLUTION_CODES[err.kind], err.message);
}

export class NotificationsService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    private readonly http: HttpSender = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
  ) {}

  private stored(): StoredConfig {
    return this.settings.getJson<StoredConfig>('whatsapp', { provider: 'disabled', ownerPhone: null });
  }

  private secret(v: string | undefined): string | undefined {
    if (!v) return undefined;
    try {
      return this.ctx.secrets.open(v);
    } catch {
      return undefined;
    }
  }

  isConfigured(): boolean {
    const c = this.stored();
    return c.provider !== 'disabled' && !!c.ownerPhone;
  }

  /** Avisos escolhidos pelo proprietário (estoque baixo ligado por padrão). */
  private alerts(c = this.stored()) {
    return { stockLow: c.alerts?.stockLow ?? true, cashClosed: c.alerts?.cashClosed ?? false };
  }

  /** Configuração para a tela (segredos nunca retornam, apenas se existem). */
  config(actor: Actor) {
    requirePerm(actor, 'settings.manage');
    const c = this.stored();
    return {
      provider: c.provider,
      ownerPhone: c.ownerPhone,
      meta: { phoneNumberId: c.meta?.phoneNumberId ?? '', templateName: c.meta?.templateName ?? '', templateLanguage: c.meta?.templateLanguage ?? 'pt_BR', hasAccessToken: !!c.meta?.accessToken },
      twilio: { accountSid: c.twilio?.accountSid ?? '', from: c.twilio?.from ?? '', hasAuthToken: !!c.twilio?.authToken },
      webhook: { url: c.webhook?.url ?? '', hasToken: !!c.webhook?.token },
      evolution: { baseUrl: c.evolution?.baseUrl ?? '', instance: c.evolution?.instance ?? '', hasApiKey: !!c.evolution?.apiKey },
      alerts: this.alerts(c),
    };
  }

  saveConfig(actor: Actor, raw: unknown) {
    requirePerm(actor, 'settings.manage');
    const input = whatsappSchema.parse(raw);
    const prev = this.stored();
    const seal = (v: string | undefined, old: string | undefined) => (v ? this.ctx.secrets.seal(v) : old);
    const next: StoredConfig = {
      provider: input.provider,
      ownerPhone: input.ownerPhone,
      meta: {
        phoneNumberId: input.meta?.phoneNumberId ?? prev.meta?.phoneNumberId,
        accessToken: seal(input.meta?.accessToken, prev.meta?.accessToken),
        templateName: input.meta?.templateName ?? prev.meta?.templateName,
        templateLanguage: input.meta?.templateLanguage ?? prev.meta?.templateLanguage,
      },
      twilio: {
        accountSid: input.twilio?.accountSid ?? prev.twilio?.accountSid,
        authToken: seal(input.twilio?.authToken, prev.twilio?.authToken),
        from: input.twilio?.from ?? prev.twilio?.from,
      },
      webhook: { url: input.webhook?.url ?? prev.webhook?.url, token: seal(input.webhook?.token, prev.webhook?.token) },
      evolution: this.mergeEvolution(prev, input.evolution),
      alerts: { ...this.alerts(prev), ...input.alerts },
    };
    if (next.provider !== 'disabled' && !next.ownerPhone) throw badRequest('Informe o WhatsApp do proprietário.');
    if (next.provider === 'evolution') {
      const e = next.evolution;
      if (!e?.baseUrl || !e.instance) throw badRequest('Complete os dados da Evolution API: endereço e nome da instância.');
      if (!e.apiKey) throw badRequest('Informe a chave da API (apikey) da Evolution.');
    }
    this.ctx.tx(() => {
      this.settings.setJson('whatsapp', next);
      this.ctx.audit(actor, 'notifications.whatsapp_config', 'settings', 'whatsapp', { provider: next.provider, alerts: next.alerts });
    });
    return this.config(actor);
  }

  /**
   * Junta os dados da Evolution recebidos com os salvos. A chave salva só é
   * mantida se o endereço continuar o mesmo: trocar de servidor exige informar
   * a chave de novo (a chave guardada nunca é enviada para outro endereço).
   */
  private mergeEvolution(prev: StoredConfig, input: { baseUrl?: string; apiKey?: string; instance?: string } | undefined): StoredConfig['evolution'] {
    const old = prev.evolution ?? {};
    const baseUrl = input?.baseUrl ?? old.baseUrl;
    const keepKey = !!old.apiKey && sameOrigin(baseUrl, old.baseUrl);
    return {
      baseUrl,
      instance: input?.instance ?? old.instance,
      apiKey: input?.apiKey ? this.ctx.secrets.seal(input.apiKey) : keepKey ? old.apiKey : undefined,
    };
  }

  /** Enfileira um aviso (no máximo um por chave de deduplicação). */
  private enqueue(kind: string, dedupeKey: string, refId: string, payload: Record<string, unknown>): void {
    const now = this.ctx.clock.now();
    this.ctx.db.run(
      `INSERT INTO notifications (id, channel, kind, dedupe_key, ref_id, payload_json, status, next_attempt_at, expires_at, created_at)
       VALUES (?, 'whatsapp', ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
      this.ctx.id(), kind, dedupeKey, refId, JSON.stringify(payload), now.toISOString(),
      addMs(now, ALERT_TTL_MS).toISOString(), now.toISOString(),
    );
  }

  /** Enfileira aviso de estoque baixo (um por episódio de alerta). */
  enqueueStockAlert(alertId: string, productId: string): void {
    if (!this.isConfigured() || !this.settings.operation().lowStockAlertsEnabled || !this.alerts().stockLow) return;
    this.enqueue('stock_low', `stock_low:${alertId}`, alertId, { productId });
  }

  /** Enfileira o resumo do fechamento de caixa (quando o proprietário escolheu receber). */
  enqueueCashClosed(sessionId: string): void {
    if (!this.isConfigured() || !this.alerts().cashClosed) return;
    this.enqueue('cash_closed', `cash_closed:${sessionId}`, sessionId, {});
  }

  private stockMessage(alertId: string): string | null {
    const a = this.ctx.db.get<{ status: string; name: string; measure: Measure; stock_qty: number; min_stock: number; package_qty: number; package_label: string | null }>(
      `SELECT a.status, p.name, p.measure, p.stock_qty, p.min_stock, p.package_qty, p.package_label
       FROM stock_alerts a JOIN products p ON p.id = a.product_id WHERE a.id = ?`,
      alertId,
    );
    // Pertinência: se o estoque já foi reposto, a mensagem não é mais enviada.
    if (!a || a.status !== 'open') return null;
    const bar = this.settings.branding().tradeName;
    const s = restockSuggestion(a.stock_qty, a.min_stock, a.package_qty);
    const pkg = a.package_label || 'embalagem(ns)';
    return [
      `*${bar}* — alerta de estoque (RupBar)`,
      `Produto: ${a.name}`,
      `Saldo atual: ${formatQty(a.stock_qty, a.measure)}`,
      `Estoque mínimo: ${formatQty(a.min_stock, a.measure)}`,
      s.packages > 0 ? `Sugestão de reposição: ${s.packages} × ${pkg} (${formatQty(s.qty, a.measure)})` : '',
    ].filter(Boolean).join('\n');
  }

  private cashMessage(sessionId: string): string | null {
    const s = this.ctx.db.get<{ number: number; status: string; summary_json: string | null }>(
      'SELECT number, status, summary_json FROM cash_sessions WHERE id = ?',
      sessionId,
    );
    if (!s || s.status !== 'closed' || !s.summary_json) return null;
    const sum = JSON.parse(s.summary_json) as CashClosingSummary;
    const bar = this.settings.branding().tradeName;
    const methods = Object.entries(sum.byMethod)
      .filter(([, v]) => v)
      .map(([m, v]) => `• ${PAYMENT_METHODS[m as PaymentMethod] ?? m}: ${formatBRL(v)}`);
    const diff = sum.difference;
    return [
      `*${bar}* — caixa nº ${s.number} fechado (RupBar)`,
      `Total recebido: ${formatBRL(sum.totalSales)}`,
      ...methods,
      `Dinheiro esperado na gaveta: ${formatBRL(sum.expectedCash)}`,
      sum.countedCash !== null ? `Dinheiro contado: ${formatBRL(sum.countedCash)}` : '',
      diff === null ? '' : diff === 0 ? 'Caixa conferido, sem diferença.' : `Diferença: ${diff > 0 ? 'sobra' : 'falta'} de ${formatBRL(Math.abs(diff))}`,
    ].filter(Boolean).join('\n');
  }

  async send(text: string, cfg = this.stored()): Promise<void> {
    const to = cfg.ownerPhone ? phoneToE164(cfg.ownerPhone) : null;
    if (!to) throw new Error('WhatsApp do proprietário não configurado');
    let res: Awaited<ReturnType<HttpSender>>;
    switch (cfg.provider) {
      case 'meta': {
        const token = this.secret(cfg.meta?.accessToken);
        if (!cfg.meta?.phoneNumberId || !token) throw new Error('Credenciais da Meta incompletas');
        const body = cfg.meta.templateName
          ? {
              messaging_product: 'whatsapp', to: to.slice(1), type: 'template',
              template: {
                name: cfg.meta.templateName, language: { code: cfg.meta.templateLanguage || 'pt_BR' },
                components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\n/g, ' · ').slice(0, 1000) }] }],
              },
            }
          : { messaging_product: 'whatsapp', to: to.slice(1), type: 'text', text: { body: text } };
        res = await this.http(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.meta.phoneNumberId)}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        break;
      }
      case 'twilio': {
        const auth = this.secret(cfg.twilio?.authToken);
        if (!cfg.twilio?.accountSid || !auth || !cfg.twilio.from) throw new Error('Credenciais da Twilio incompletas');
        const form = new URLSearchParams({ From: `whatsapp:${cfg.twilio.from}`, To: `whatsapp:${to}`, Body: text });
        res = await this.http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.twilio.accountSid)}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${cfg.twilio.accountSid}:${auth}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        break;
      }
      case 'webhook': {
        if (!cfg.webhook?.url) throw new Error('URL do provedor não configurada');
        const token = this.secret(cfg.webhook.token);
        res = await this.http(cfg.webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ to, text, source: 'rupbar' }),
        });
        break;
      }
      case 'evolution': {
        // Evolution espera só dígitos: 55 + DDD + número.
        await this.evolutionClient(this.savedEvolution(cfg)).sendText(phoneToWhatsApp(cfg.ownerPhone!)!, text);
        return;
      }
      default:
        throw new Error('WhatsApp desativado');
    }
    if (!res.ok) throw new Error(`Provedor respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  private testText(): string {
    return `RupBar: teste de notificação de ${this.settings.branding().tradeName}. Tudo certo! Os alertas do bar vão chegar por aqui.`;
  }

  async test(actor: Actor): Promise<{ ok: true }> {
    requirePerm(actor, 'settings.manage');
    try {
      await this.send(this.testText());
    } catch (err) {
      // Mensagem do provedor para o proprietário, em vez de "erro interno".
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'WHATSAPP_SEND_FAILED', err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ Evolution API

  private evolutionClient(creds: EvolutionCredentials): EvolutionClient {
    return new EvolutionClient(this.http, creds);
  }

  /** Credenciais salvas (fila de envio). */
  private savedEvolution(cfg: StoredConfig): EvolutionCredentials {
    const e = cfg.evolution;
    const apiKey = this.secret(e?.apiKey);
    if (!e?.baseUrl || !e.instance || !apiKey) throw new Error('Dados da Evolution API incompletos');
    return { baseUrl: e.baseUrl, apiKey, instance: e.instance };
  }

  /**
   * Credenciais para as ações do assistente: o que vier na requisição tem
   * prioridade; o que faltar vem do que já está salvo (a chave salva só vale
   * para o mesmo endereço).
   */
  private evolutionCreds(raw: unknown): EvolutionCredentials {
    const input = evolutionCredentialsSchema.parse(raw ?? {});
    const saved = this.stored().evolution ?? {};
    const baseUrl = input.baseUrl ?? saved.baseUrl;
    const instance = input.instance ?? saved.instance;
    const apiKey = input.apiKey ?? (sameOrigin(baseUrl, saved.baseUrl) ? this.secret(saved.apiKey) : undefined);
    if (!baseUrl) throw badRequest('Informe o endereço da Evolution API.', 'EVOLUTION_CONFIG');
    if (!apiKey) throw badRequest('Informe a chave da API (apikey) da Evolution.', 'EVOLUTION_CONFIG');
    if (!instance) throw badRequest('Informe o nome da instância.', 'EVOLUTION_CONFIG');
    return { baseUrl, apiKey, instance };
  }

  /** Guarda endereço, instância e chave (cifrada) sem mudar o provedor ativo. */
  private persistEvolution(actor: Actor, creds: EvolutionCredentials): void {
    const prev = this.stored();
    const old = prev.evolution;
    if (old?.baseUrl === creds.baseUrl && old.instance === creds.instance && this.secret(old.apiKey) === creds.apiKey) return;
    this.ctx.tx(() => {
      this.settings.setJson('whatsapp', { ...prev, evolution: { baseUrl: creds.baseUrl, instance: creds.instance, apiKey: this.ctx.secrets.seal(creds.apiKey) } });
      this.ctx.audit(actor, 'notifications.evolution_saved', 'settings', 'whatsapp', { baseUrl: creds.baseUrl, instance: creds.instance });
    });
  }

  private async evolution<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toAppError(err);
    }
  }

  /** "Testar conexão": valida endereço e chave, informa o estado e guarda os dados. */
  async evolutionTest(actor: Actor, raw: unknown) {
    requirePerm(actor, 'settings.manage');
    const creds = this.evolutionCreds(raw);
    const client = this.evolutionClient(creds);
    const st = await this.evolution(() => client.connectionState());
    // Endereço e chave aceitos: salva para o assistente poder continuar depois.
    this.persistEvolution(actor, creds);
    return { ...st, baseUrl: creds.baseUrl, instance: creds.instance, profile: st.status === 'connected' ? await client.profile() : null };
  }

  /** "Criar instância" (se já existir, segue normalmente). */
  async evolutionCreate(actor: Actor, raw: unknown) {
    requirePerm(actor, 'settings.manage');
    const creds = this.evolutionCreds(raw);
    const client = this.evolutionClient(creds);
    const r = await this.evolution(() => client.create());
    this.persistEvolution(actor, creds);
    this.ctx.tx(() => this.ctx.audit(actor, 'notifications.evolution_instance', 'settings', 'whatsapp', { instance: creds.instance, created: r.created }));
    const st = await this.evolution(() => client.connectionState());
    return { created: r.created, ...st, qr: r.qr };
  }

  /** Estado atual (consultado a cada poucos segundos enquanto o QR está na tela). */
  async evolutionState(actor: Actor) {
    requirePerm(actor, 'settings.manage');
    const client = this.evolutionClient(this.evolutionCreds({}));
    const st = await this.evolution(() => client.connectionState());
    return { ...st, profile: st.status === 'connected' ? await client.profile() : null };
  }

  /** QR Code para conectar o WhatsApp (ou status "connected" se já estiver conectado). */
  async evolutionQr(actor: Actor) {
    requirePerm(actor, 'settings.manage');
    const client = this.evolutionClient(this.evolutionCreds({}));
    return this.evolution(() => client.connect());
  }

  /** Desconecta o WhatsApp da instância (o aparelho sai de "Aparelhos conectados"). */
  async evolutionLogout(actor: Actor) {
    requirePerm(actor, 'settings.manage');
    const creds = this.evolutionCreds({});
    await this.evolution(() => this.evolutionClient(creds).logout());
    this.ctx.tx(() => this.ctx.audit(actor, 'notifications.evolution_logout', 'settings', 'whatsapp', { instance: creds.instance }));
    return { state: 'close' as const, status: 'disconnected' as const };
  }

  /** Mensagem de teste pela Evolution, antes mesmo de ativar o provedor. */
  async evolutionSendTest(actor: Actor, raw: unknown) {
    requirePerm(actor, 'settings.manage');
    const input = whatsappSendTestSchema.parse(raw ?? {});
    const phone = input.phone ?? this.stored().ownerPhone;
    const number = phone ? phoneToWhatsApp(phone) : null;
    if (!number) throw badRequest('Informe o WhatsApp que vai receber a mensagem de teste.');
    const client = this.evolutionClient(this.evolutionCreds({}));
    await this.evolution(() => client.sendText(number, this.testText()));
    return { ok: true as const };
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.processQueue(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processQueue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const now = this.ctx.clock.now();
      const due = this.ctx.db.all<{ id: string; kind: string; ref_id: string; attempts: number; expires_at: string | null }>(
        "SELECT id, kind, ref_id, attempts, expires_at FROM notifications WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 20",
        now.toISOString(),
      );
      for (const n of due) {
        if (n.expires_at && Date.parse(n.expires_at) < now.getTime()) {
          this.ctx.db.run("UPDATE notifications SET status = 'discarded', last_error = 'expirada' WHERE id = ?", n.id);
          continue;
        }
        const text = n.kind === 'stock_low' ? this.stockMessage(n.ref_id) : n.kind === 'cash_closed' ? this.cashMessage(n.ref_id) : null;
        if (!text) {
          this.ctx.db.run("UPDATE notifications SET status = 'discarded', last_error = 'não é mais pertinente' WHERE id = ?", n.id);
          continue;
        }
        try {
          await this.send(text);
          this.ctx.db.run("UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?", this.ctx.nowIso(), n.id);
          sent++;
        } catch (err) {
          const attempts = n.attempts + 1;
          this.ctx.db.run(
            'UPDATE notifications SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
            attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, err instanceof Error ? err.message : String(err),
            addMs(this.ctx.clock.now(), backoffMs(attempts, 30_000, 30 * 60_000)).toISOString(), n.id,
          );
        }
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  list(actor: Actor) {
    requirePerm(actor, 'settings.manage');
    return this.ctx.db.all('SELECT id, kind, status, attempts, last_error, created_at, sent_at FROM notifications ORDER BY created_at DESC LIMIT 100');
  }
}
