import { SYSTEM_ROLES, sanitizeGrantable, type SystemRoleKey } from '@rupbar/core';
import { roleSchema, userCreateSchema, userUpdateSchema } from '@rupbar/core/schemas';
import { json } from '../db/db';
import { hashPassword, temporaryPassword } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type { AuthService } from './auth';
import { requirePerm, type Actor, type Ctx } from './context';

export class UsersService {
  constructor(
    private readonly ctx: Ctx,
    private readonly auth: AuthService,
  ) {}

  /** Cria os perfis iniciais (idempotente). */
  ensureSystemRoles(): void {
    const now = this.ctx.nowIso();
    for (const [key, def] of Object.entries(SYSTEM_ROLES) as [SystemRoleKey, (typeof SYSTEM_ROLES)[SystemRoleKey]][]) {
      const exists = this.ctx.db.value('SELECT id FROM roles WHERE key = ?', key);
      if (exists) continue;
      this.ctx.db.run(
        'INSERT INTO roles (id, key, name, description, permissions_json, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)',
        this.ctx.id(), key, def.name, def.description, JSON.stringify(key === 'owner' ? [] : def.permissions), now, now,
      );
    }
  }

  roleIdByKey(key: SystemRoleKey): string {
    const id = this.ctx.db.value<string>('SELECT id FROM roles WHERE key = ?', key);
    if (!id) throw notFound('Perfil');
    return id;
  }

  listRoles(actor: Actor) {
    requirePerm(actor, 'users.manage');
    return this.ctx.db
      .all(
        `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count FROM roles r
         ORDER BY r.is_system DESC, r.name`,
      )
      .map((r) => ({
        id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.is_system === 1,
        permissions: r.key === 'owner' ? ['*'] : json<string[]>(r.permissions_json, []), userCount: r.user_count,
      }));
  }

  createRole(actor: Actor, raw: unknown) {
    requirePerm(actor, 'roles.manage');
    const input = roleSchema.parse(raw);
    const id = this.ctx.id();
    this.ctx.tx(() => {
      if (this.ctx.db.value('SELECT id FROM roles WHERE name = ? COLLATE NOCASE', input.name)) throw conflict('Já existe um cargo com este nome.');
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        'INSERT INTO roles (id, key, name, description, permissions_json, is_system, created_at, updated_at) VALUES (?,NULL,?,?,?,0,?,?)',
        id, input.name, input.description, JSON.stringify(sanitizeGrantable(input.permissions)), now, now,
      );
      this.ctx.audit(actor, 'roles.created', 'role', id, { name: input.name, permissions: sanitizeGrantable(input.permissions) });
    });
    return { id };
  }

  updateRole(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'roles.manage');
    const input = roleSchema.parse(raw);
    this.ctx.tx(() => {
      const role = this.ctx.db.get('SELECT * FROM roles WHERE id = ?', id);
      if (!role) throw notFound('Cargo');
      if (role.key === 'owner') throw forbidden('O perfil Proprietário não pode ser alterado.');
      const perms = sanitizeGrantable(input.permissions);
      const name = role.is_system === 1 ? String(role.name) : input.name;
      this.ctx.db.run(
        'UPDATE roles SET name = ?, description = ?, permissions_json = ?, version = version + 1, updated_at = ? WHERE id = ?',
        name, input.description, JSON.stringify(perms), this.ctx.nowIso(), id,
      );
      // Alteração de permissões invalida as sessões de quem usa o cargo.
      for (const u of this.ctx.db.all<{ id: string }>('SELECT id FROM users WHERE role_id = ?', id)) {
        this.ctx.db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', u.id);
        this.auth.revokeUserSessions(u.id, 'role_changed');
      }
      this.ctx.audit(actor, 'roles.updated', 'role', id, { before: json(role.permissions_json, []), after: perms });
    });
  }

  deleteRole(actor: Actor, id: string) {
    requirePerm(actor, 'roles.manage');
    this.ctx.tx(() => {
      const role = this.ctx.db.get('SELECT * FROM roles WHERE id = ?', id);
      if (!role) throw notFound('Cargo');
      if (role.is_system === 1) throw forbidden('Perfis do sistema não podem ser excluídos.');
      if (Number(this.ctx.db.value('SELECT COUNT(*) FROM users WHERE role_id = ?', id)) > 0) {
        throw conflict('Há funcionários usando este cargo. Mova-os antes de excluir.');
      }
      this.ctx.db.run('DELETE FROM roles WHERE id = ?', id);
      this.ctx.audit(actor, 'roles.deleted', 'role', id, { name: role.name });
    });
  }

  list(actor: Actor) {
    requirePerm(actor, 'users.manage');
    return this.ctx.db
      .all(
        `SELECT u.id, u.name, u.email, u.status, u.must_change_password, u.last_login_at, u.created_at, u.grants_json, u.denies_json,
                r.id AS role_id, r.name AS role_name, r.key AS role_key
         FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.status, u.name`,
      )
      .map((u) => ({
        id: u.id, name: u.name, email: u.email, status: u.status, mustChangePassword: u.must_change_password === 1,
        lastLoginAt: u.last_login_at, createdAt: u.created_at, roleId: u.role_id, roleName: u.role_name, roleKey: u.role_key,
        grants: json(u.grants_json, []), denies: json(u.denies_json, []),
      }));
  }

  /** Lista enxuta para seleção de responsável/atendente (sem e-mail). */
  staff() {
    return this.ctx.db.all(
      `SELECT u.id, u.name, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'active' ORDER BY u.name`,
    );
  }

  /** Cria funcionário com senha temporária (troca obrigatória no 1º acesso). */
  async create(actor: Actor, raw: unknown): Promise<{ id: string; temporaryPassword: string }> {
    requirePerm(actor, 'users.manage');
    const input = userCreateSchema.parse(raw);
    const role = this.ctx.db.get('SELECT * FROM roles WHERE id = ?', input.roleId);
    if (!role) throw notFound('Cargo');
    if (role.key === 'owner') throw forbidden('Só existe um proprietário por estabelecimento.');
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    const id = this.ctx.id();
    this.ctx.tx(() => {
      if (this.ctx.db.value('SELECT id FROM users WHERE email = ?', input.email)) throw conflict('Já existe um funcionário com este e-mail.');
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO users (id, name, email, password_hash, role_id, grants_json, denies_json, must_change_password, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,1,?,?)`,
        id, input.name, input.email, hash, input.roleId, JSON.stringify(sanitizeGrantable(input.grants)),
        JSON.stringify(input.denies), now, now,
      );
      this.ctx.audit(actor, 'users.created', 'user', id, { name: input.name, email: input.email, role: role.name });
    });
    return { id, temporaryPassword: temp };
  }

  update(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'users.manage');
    const input = userUpdateSchema.parse(raw);
    this.ctx.tx(() => {
      const u = this.ctx.db.get('SELECT u.*, r.key AS role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', id);
      if (!u) throw notFound('Funcionário');
      if (u.role_key === 'owner' && (input.roleId || input.status === 'blocked')) {
        throw forbidden('O proprietário não pode ser bloqueado nem mudar de perfil.');
      }
      if (input.roleId) {
        const role = this.ctx.db.get('SELECT key FROM roles WHERE id = ?', input.roleId);
        if (!role) throw notFound('Cargo');
        if (role.key === 'owner') throw forbidden('Só existe um proprietário por estabelecimento.');
      }
      const grants = input.grants ? sanitizeGrantable(input.grants) : json<string[]>(u.grants_json, []);
      const denies = input.denies ?? json<string[]>(u.denies_json, []);
      const permsChanged =
        (input.roleId && input.roleId !== u.role_id) ||
        JSON.stringify(grants) !== String(u.grants_json) ||
        JSON.stringify(denies) !== String(u.denies_json);
      const statusChanged = input.status && input.status !== u.status;
      this.ctx.db.run(
        `UPDATE users SET name = ?, role_id = ?, grants_json = ?, denies_json = ?, status = ?,
           token_version = token_version + ?, version = version + 1, updated_at = ? WHERE id = ?`,
        input.name ?? String(u.name), input.roleId ?? String(u.role_id), JSON.stringify(grants), JSON.stringify(denies),
        input.status ?? String(u.status), permsChanged || statusChanged ? 1 : 0, this.ctx.nowIso(), id,
      );
      if (permsChanged || statusChanged) this.auth.revokeUserSessions(id, statusChanged ? `status_${input.status}` : 'permissions_changed');
      this.ctx.audit(actor, statusChanged ? `users.${input.status}` : 'users.updated', 'user', id, {
        roleId: input.roleId, grants, denies, status: input.status,
      });
    });
  }

  /** Redefine a senha: gera senha temporária e encerra as sessões do funcionário. */
  async resetPassword(actor: Actor, id: string): Promise<{ temporaryPassword: string }> {
    requirePerm(actor, 'users.manage');
    const u = this.ctx.db.get('SELECT u.id, r.key AS role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', id);
    if (!u) throw notFound('Funcionário');
    if (u.id === actor.userId) throw badRequest('Use "Alterar minha senha" para a sua própria conta.');
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    this.ctx.tx(() => {
      this.ctx.db.run(
        `UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL,
           token_version = token_version + 1, version = version + 1, updated_at = ? WHERE id = ?`,
        hash, this.ctx.nowIso(), id,
      );
      this.auth.revokeUserSessions(id, 'password_reset');
      this.ctx.audit(actor, 'users.password_reset', 'user', id);
    });
    return { temporaryPassword: temp };
  }

  accessHistory(actor: Actor, id: string) {
    requirePerm(actor, 'users.manage');
    return { events: this.auth.history(id), sessions: this.auth.activeSessions(id) };
  }

  revokeSession(actor: Actor, userId: string, sessionId: string) {
    requirePerm(actor, 'users.manage');
    this.ctx.tx(() => {
      this.ctx.db.run(
        "UPDATE sessions SET revoked_at = ?, revoke_reason = 'revoked_by_owner' WHERE id = ? AND user_id = ?",
        this.ctx.nowIso(), sessionId, userId,
      );
      this.ctx.audit(actor, 'users.session_revoked', 'user', userId, { sessionId });
    });
  }
}
