import { backoffMs, formatQty, phoneToE164, restockSuggestion, type Measure } from '@rupbar/core';
import { whatsappSchema } from '@rupbar/core/schemas';
import { badRequest } from '../lib/errors';
import { addMs } from '../lib/time';
import { requirePerm, type Actor, type Ctx } from './context';
import type { SettingsService } from './settings';

const MAX_ATTEMPTS = 12;
const ALERT_TTL_MS = 24 * 3_600_000;

export type WhatsAppProvider = 'disabled' | 'meta' | 'twilio' | 'webhook';

/** Configuração persistida: segredos sempre cifrados (SecretBox). */
interface StoredConfig {
  provider: WhatsAppProvider;
  ownerPhone: string | null;
  meta?: { phoneNumberId?: string; accessToken?: string; templateName?: string; templateLanguage?: string };
  twilio?: { accountSid?: string; authToken?: string; from?: string };
  webhook?: { url?: string; token?: string };
}

export type HttpSender = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

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
    };
    if (next.provider !== 'disabled' && !next.ownerPhone) throw badRequest('Informe o WhatsApp do proprietário.');
    this.ctx.tx(() => {
      this.settings.setJson('whatsapp', next);
      this.ctx.audit(actor, 'notifications.whatsapp_config', 'settings', 'whatsapp', { provider: next.provider });
    });
    return this.config(actor);
  }

  /** Enfileira aviso de estoque baixo (um por episódio de alerta). */
  enqueueStockAlert(alertId: string, productId: string): void {
    if (!this.isConfigured() || !this.settings.operation().lowStockAlertsEnabled) return;
    const now = this.ctx.clock.now();
    this.ctx.db.run(
      `INSERT INTO notifications (id, channel, kind, dedupe_key, ref_id, payload_json, status, next_attempt_at, expires_at, created_at)
       VALUES (?, 'whatsapp', 'stock_low', ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
      this.ctx.id(), `stock_low:${alertId}`, alertId, JSON.stringify({ productId }), now.toISOString(),
      addMs(now, ALERT_TTL_MS).toISOString(), now.toISOString(),
    );
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
      default:
        throw new Error('WhatsApp desativado');
    }
    if (!res.ok) throw new Error(`Provedor respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async test(actor: Actor): Promise<{ ok: true }> {
    requirePerm(actor, 'settings.manage');
    await this.send(`RupBar: teste de notificação de ${this.settings.branding().tradeName}. Tudo certo!`);
    return { ok: true };
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
        const text = n.kind === 'stock_low' ? this.stockMessage(n.ref_id) : null;
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
