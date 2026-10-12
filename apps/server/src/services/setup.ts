import { checkPasswordStrength } from '@rupbar/core';
import { setupSchema } from '@rupbar/core/schemas';
import { hashPassword } from '../lib/crypto';
import { badRequest, conflict } from '../lib/errors';
import type { AuthService, RequestMeta } from './auth';
import type { CatalogService } from './catalog';
import { SYSTEM_ACTOR, type Ctx } from './context';
import type { SettingsService } from './settings';
import type { UsersService } from './users';

export class SetupService {
  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly catalog: CatalogService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Assistente de primeira instalação. Cria o estabelecimento, os perfis, a
   * conta do proprietário e as configurações iniciais em uma única transação.
   */
  async run(raw: unknown, meta: RequestMeta) {
    if (this.settings.isConfigured()) throw conflict('O RupBar já foi configurado neste computador.', 'ALREADY_CONFIGURED');
    const input = setupSchema.parse(raw);
    const strength = checkPasswordStrength(input.owner.password, [input.owner.name, input.owner.email]);
    if (!strength.ok) throw badRequest(strength.problems.join(' '), 'WEAK_PASSWORD');
    const hash = await hashPassword(input.owner.password);

    this.ctx.tx(() => {
      if (this.settings.isConfigured()) throw conflict('O RupBar já foi configurado neste computador.', 'ALREADY_CONFIGURED');
      const now = this.ctx.nowIso();
      const establishmentId = this.ctx.id();
      const i = input.identity;
      this.ctx.db.run(
        `INSERT INTO establishment (id, trade_name, legal_name, cnpj, phone, address_json, primary_color, secondary_color, instagram,
           facebook, whatsapp, website, owner_email, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        establishmentId, i.tradeName, i.legalName, i.cnpj, i.phone, JSON.stringify(i.address), i.primaryColor, i.secondaryColor,
        i.instagram, i.facebook, i.whatsapp, i.website, input.owner.email, now, now,
      );
      this.users.ensureSystemRoles();
      const ownerId = this.ctx.id();
      this.ctx.db.run(
        `INSERT INTO users (id, name, email, password_hash, role_id, must_change_password, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)`,
        ownerId, input.owner.name, input.owner.email, hash, this.users.roleIdByKey('owner'), now, now,
      );
      this.settings.saveOperation(input.operation);
      if (input.seedCategories) this.catalog.seedCategories();
      this.ctx.setMeta('establishment_id', establishmentId);
      this.ctx.setMeta('installed_at', now);
      this.ctx.audit({ ...SYSTEM_ACTOR, userId: ownerId, name: input.owner.name }, 'setup.completed', 'establishment', establishmentId, {
        tradeName: i.tradeName,
      });
    });
    return this.auth.login({ email: input.owner.email, password: input.owner.password, deviceLabel: 'PC do bar' }, meta);
  }
}
