import { buildPixPayload, comandaPixTxid, initials, PIX_CITY_MAX, PIX_KEY_TYPES, PIX_NAME_MAX, sanitizePixText, sanitizeTxid, type PixKeyType } from '@rupbar/core';
import {
  identitySchema, operationSettingsSchema, pixPayloadQuerySchema, pixSettingsSchema, type IdentityInput, type OperationSettings, type PixSettings,
} from '@rupbar/core/schemas';
import { json, type Row } from '../db/db';
import { conflict, forbidden, notFound } from '../lib/errors';
import { hasPerm, requirePerm, type Actor, type Ctx } from './context';

export interface Branding {
  configured: boolean;
  establishmentId: string | null;
  tradeName: string;
  initials: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  coverUrl: string | null;
  phone: string | null;
  instagram: string | null;
  facebook: string | null;
  whatsapp: string | null;
  website: string | null;
}

/** Cobrança Pix pronta para exibir (tela) ou imprimir (conta). */
export interface PixCharge {
  /** Pix copia e cola (BR Code) — o mesmo texto do QR Code. */
  payload: string;
  amountCents: number;
  txid: string;
  /** Nome e cidade como saem no BR Code (sem acentos, truncados). */
  merchantName: string;
  merchantCity: string;
  keyType: PixKeyType;
  keyLabel: string;
  key: string;
}

export function attachmentUrl(id: string | null | undefined): string | null {
  return id ? `/api/files/${id}` : null;
}

export class SettingsService {
  constructor(private readonly ctx: Ctx) {}

  isConfigured(): boolean {
    return !!this.ctx.db.value('SELECT id FROM establishment LIMIT 1');
  }

  establishmentRow(): Row | undefined {
    return this.ctx.db.get('SELECT * FROM establishment LIMIT 1');
  }

  /** Dados públicos de identidade visual (login, TV, cupons). Sem dados sensíveis. */
  branding(): Branding {
    const e = this.establishmentRow();
    if (!e) {
      return {
        configured: false, establishmentId: null, tradeName: 'RupBar', initials: 'RB', primaryColor: '#0A84FF',
        secondaryColor: '#1C1C1E', logoUrl: null, coverUrl: null, phone: null, instagram: null, facebook: null,
        whatsapp: null, website: null,
      };
    }
    const name = String(e.trade_name);
    return {
      configured: true,
      establishmentId: String(e.id),
      tradeName: name,
      initials: initials(name),
      primaryColor: String(e.primary_color),
      secondaryColor: String(e.secondary_color),
      logoUrl: attachmentUrl(e.logo_attachment_id as string | null),
      coverUrl: attachmentUrl(e.cover_attachment_id as string | null),
      phone: (e.phone as string) ?? null,
      instagram: (e.instagram as string) ?? null,
      facebook: (e.facebook as string) ?? null,
      whatsapp: (e.whatsapp as string) ?? null,
      website: (e.website as string) ?? null,
    };
  }

  identity(actor: Actor) {
    requirePerm(actor, 'settings.manage');
    const e = this.establishmentRow();
    if (!e) throw notFound('Estabelecimento');
    return {
      tradeName: e.trade_name,
      legalName: e.legal_name,
      cnpj: e.cnpj,
      phone: e.phone,
      address: json(e.address_json, {}),
      primaryColor: e.primary_color,
      secondaryColor: e.secondary_color,
      instagram: e.instagram,
      facebook: e.facebook,
      whatsapp: e.whatsapp,
      website: e.website,
      ownerEmail: e.owner_email,
      logoUrl: attachmentUrl(e.logo_attachment_id as string | null),
      coverUrl: attachmentUrl(e.cover_attachment_id as string | null),
    };
  }

  updateIdentity(actor: Actor, raw: unknown): Branding {
    requirePerm(actor, 'settings.manage');
    const input: IdentityInput = identitySchema.parse(raw);
    return this.ctx.tx(() => {
      const e = this.establishmentRow();
      if (!e) throw notFound('Estabelecimento');
      this.ctx.db.run(
        `UPDATE establishment SET trade_name=?, legal_name=?, cnpj=?, phone=?, address_json=?, primary_color=?, secondary_color=?,
         instagram=?, facebook=?, whatsapp=?, website=?, version=version+1, updated_at=? WHERE id=?`,
        input.tradeName, input.legalName, input.cnpj, input.phone, JSON.stringify(input.address), input.primaryColor,
        input.secondaryColor, input.instagram, input.facebook, input.whatsapp, input.website, this.ctx.nowIso(), e.id as string,
      );
      this.ctx.audit(actor, 'settings.identity_updated', 'establishment', e.id as string, { tradeName: input.tradeName });
      this.ctx.emit({ channel: 'system', type: 'branding.updated' });
      this.ctx.emit({ channel: 'tv', type: 'branding.updated' });
      return this.branding();
    });
  }

  setImage(actor: Actor, slot: 'logo' | 'cover', attachmentId: string | null): Branding {
    requirePerm(actor, 'settings.manage');
    return this.ctx.tx(() => {
      const e = this.establishmentRow();
      if (!e) throw notFound('Estabelecimento');
      const col = slot === 'logo' ? 'logo_attachment_id' : 'cover_attachment_id';
      this.ctx.db.run(`UPDATE establishment SET ${col}=?, version=version+1, updated_at=? WHERE id=?`, attachmentId, this.ctx.nowIso(), e.id as string);
      this.ctx.audit(actor, attachmentId ? `settings.${slot}_set` : `settings.${slot}_removed`, 'establishment', e.id as string);
      this.ctx.emit({ channel: 'system', type: 'branding.updated' });
      this.ctx.emit({ channel: 'tv', type: 'branding.updated' });
      return this.branding();
    });
  }

  operation(): OperationSettings {
    const raw = this.ctx.db.value<string>("SELECT value_json FROM settings WHERE key = 'operation'");
    return operationSettingsSchema.parse(raw ? JSON.parse(raw) : {});
  }

  updateOperation(actor: Actor, raw: unknown): OperationSettings {
    requirePerm(actor, 'settings.manage');
    const merged = operationSettingsSchema.parse({ ...this.operation(), ...(raw as object) });
    this.ctx.tx(() => {
      this.saveOperation(merged);
      this.ctx.audit(actor, 'settings.operation_updated', 'settings', 'operation', merged as unknown as Record<string, unknown>);
    });
    return merged;
  }

  saveOperation(s: OperationSettings): void {
    this.ctx.db.run(
      `INSERT INTO settings(key, value_json, updated_at) VALUES ('operation', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      JSON.stringify(s),
      this.ctx.nowIso(),
    );
  }

  // ------------------------------------------------------------- Pix

  /** Configuração do Pix copia e cola (padrão: desativado). */
  pix(): PixSettings {
    const parsed = pixSettingsSchema.safeParse(this.getJson<unknown>('pix', {}));
    return parsed.success ? parsed.data : pixSettingsSchema.parse({});
  }

  /** Tela de configurações e quem recebe pagamentos (o QR mostra a chave de qualquer forma). */
  pixConfig(actor: Actor): PixSettings {
    if (!hasPerm(actor, 'settings.manage') && !hasPerm(actor, 'cash.payment')) throw forbidden();
    return this.pix();
  }

  updatePix(actor: Actor, raw: unknown): PixSettings {
    requirePerm(actor, 'settings.manage');
    const input = pixSettingsSchema.parse(raw);
    this.ctx.tx(() => {
      this.setJson('pix', input);
      this.ctx.audit(actor, 'settings.pix_updated', 'settings', 'pix', { enabled: input.enabled, keyType: input.keyType });
      this.ctx.emit({ channel: 'system', type: 'pix.updated' });
    });
    return input;
  }

  /**
   * Cobrança Pix estática do valor informado (0 = o cliente digita o valor).
   * Retorna null quando o Pix não está ativo.
   */
  pixCharge(amountCents: number, txid?: string | null): PixCharge | null {
    const c = this.pix();
    if (!c.enabled || !c.key) return null;
    const ref = sanitizeTxid(txid);
    return {
      payload: buildPixPayload({ key: c.key, merchantName: c.merchantName, merchantCity: c.merchantCity, amountCents, txid: ref }),
      amountCents,
      txid: ref,
      merchantName: sanitizePixText(c.merchantName, PIX_NAME_MAX),
      merchantCity: sanitizePixText(c.merchantCity, PIX_CITY_MAX),
      keyType: c.keyType,
      keyLabel: PIX_KEY_TYPES[c.keyType],
      key: c.key,
    };
  }

  /** GET /api/pix/payload: valor e comanda vêm da tela de pagamento. */
  pixPayload(actor: Actor, query: unknown): PixCharge {
    if (!hasPerm(actor, 'cash.payment') && !hasPerm(actor, 'comandas.view')) throw forbidden();
    const q = pixPayloadQuerySchema.parse(query);
    let txid: string | null = null;
    if (q.comandaId) {
      const n = this.ctx.db.value<number>('SELECT number FROM comandas WHERE id = ?', q.comandaId);
      if (n === undefined || n === null) throw notFound('Comanda');
      txid = comandaPixTxid(Number(n));
    }
    const charge = this.pixCharge(q.amountCents, txid);
    if (!charge) throw conflict('O Pix copia e cola ainda não foi configurado. Configure em Configurações → Pix.', 'PIX_NOT_CONFIGURED');
    return charge;
  }

  /** Configurações genéricas guardadas como JSON (impressão, WhatsApp, rede...). */
  getJson<T>(key: string, fallback: T): T {
    const raw = this.ctx.db.value<string>('SELECT value_json FROM settings WHERE key = ?', key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  }

  setJson(key: string, value: unknown): void {
    this.ctx.db.run(
      `INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      this.ctx.nowIso(),
    );
  }
}
