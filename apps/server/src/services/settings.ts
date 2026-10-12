import { initials } from '@rupbar/core';
import { identitySchema, operationSettingsSchema, type IdentityInput, type OperationSettings } from '@rupbar/core/schemas';
import { json, type Row } from '../db/db';
import { notFound } from '../lib/errors';
import { requirePerm, type Actor, type Ctx } from './context';

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
