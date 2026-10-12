import { effectivePermissions, checkPasswordStrength } from '@rupbar/core';
import { changePasswordSchema, loginSchema } from '@rupbar/core/schemas';
import { json, type Row } from '../db/db';
import { dummyVerify, hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { AppError, badRequest, unauthorized } from '../lib/errors';
import { addMinutes, addMs } from '../lib/time';
import type { Actor, Ctx } from './context';

const IDLE_TIMEOUT_MS = 14 * 3_600_000; // um turno longo
const ABSOLUTE_MAX_MS = 30 * 24 * 3_600_000;
const MAX_FAILED = 5;
const LOCK_MINUTES = 5;
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionInfo {
  actor: Actor;
  user: PublicUser;
  sessionId: string;
  mustChangePassword: boolean;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleKey: string | null;
  roleName: string;
  status: string;
  mustChangePassword: boolean;
  permissions: string[];
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export class AuthService {
  constructor(private readonly ctx: Ctx) {}

  private userWithRole(where: string, ...params: string[]): Row | undefined {
    return this.ctx.db.get(
      `SELECT u.*, r.key AS role_key, r.name AS role_name, r.permissions_json AS role_permissions
       FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`,
      ...params,
    );
  }

  toPublicUser(u: Row): PublicUser {
    const perms = effectivePermissions({
      roleKey: (u.role_key as string) ?? null,
      rolePermissions: json<string[]>(u.role_permissions, []),
      grants: json<string[]>(u.grants_json, []),
      denies: json<string[]>(u.denies_json, []),
    });
    return {
      id: String(u.id),
      name: String(u.name),
      email: String(u.email),
      roleId: String(u.role_id),
      roleKey: (u.role_key as string) ?? null,
      roleName: String(u.role_name),
      status: String(u.status),
      mustChangePassword: u.must_change_password === 1,
      permissions: [...perms].sort(),
    };
  }

  private actorFor(u: Row, sessionId: string, ip?: string | null): Actor {
    const pub = this.toPublicUser(u);
    return {
      kind: 'user',
      userId: pub.id,
      name: pub.name,
      roleKey: pub.roleKey,
      permissions: new Set(pub.permissions) as Actor['permissions'],
      ip: ip ?? null,
      sessionId,
    };
  }

  private event(userId: string | null, email: string | null, event: string, meta: RequestMeta, detail?: string) {
    this.ctx.db.run(
      'INSERT INTO auth_events (id, user_id, email, event, ip, user_agent, detail, created_at) VALUES (?,?,?,?,?,?,?,?)',
      this.ctx.id(), userId, email, event, meta.ip ?? null, meta.userAgent?.slice(0, 200) ?? null, detail ?? null, this.ctx.nowIso(),
    );
  }

  async login(raw: unknown, meta: RequestMeta): Promise<{ token: string; session: SessionInfo }> {
    const input = loginSchema.parse(raw);
    const u = this.userWithRole('u.email = ?', input.email);
    const now = this.ctx.clock.now();
    const generic = new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.');

    if (!u) {
      await dummyVerify(input.password); // tempo de resposta constante
      this.ctx.tx(() => this.event(null, input.email, 'login_failed', meta, 'unknown_email'));
      throw generic;
    }
    if (u.locked_until && Date.parse(String(u.locked_until)) > now.getTime()) {
      this.ctx.tx(() => this.event(String(u.id), input.email, 'login_locked', meta));
      throw new AppError(429, 'LOCKED', `Muitas tentativas. Tente novamente em alguns minutos.`);
    }
    const ok = await verifyPassword(input.password, String(u.password_hash));
    if (!ok) {
      this.ctx.tx(() => {
        const attempts = Number(u.failed_attempts) + 1;
        const lock = attempts >= MAX_FAILED ? addMinutes(now, LOCK_MINUTES).toISOString() : null;
        this.ctx.db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', lock ? 0 : attempts, lock, String(u.id));
        this.event(String(u.id), input.email, lock ? 'locked' : 'login_failed', meta, 'bad_password');
      });
      throw generic;
    }
    if (u.status !== 'active') {
      this.ctx.tx(() => this.event(String(u.id), input.email, 'login_blocked', meta));
      throw new AppError(403, 'USER_BLOCKED', 'Seu acesso está bloqueado. Fale com o proprietário.');
    }

    const token = randomToken(32);
    const sessionId = this.ctx.id();
    this.ctx.tx(() => {
      this.ctx.db.run(
        `INSERT INTO sessions (id, token_hash, user_id, token_version, device_label, ip, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        sessionId, sha256(token), String(u.id), Number(u.token_version), input.deviceLabel, meta.ip ?? null,
        meta.userAgent?.slice(0, 200) ?? null, now.toISOString(), now.toISOString(), addMs(now, IDLE_TIMEOUT_MS).toISOString(),
      );
      this.ctx.db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now.toISOString(), String(u.id));
      this.event(String(u.id), input.email, 'login_success', meta);
    });
    const user = this.toPublicUser(u);
    return {
      token,
      session: { actor: this.actorFor(u, sessionId, meta.ip), user, sessionId, mustChangePassword: user.mustChangePassword },
    };
  }

  /** Valida o token a cada requisição: sessão ativa, usuário ativo e permissões atuais. */
  resolve(token: string | null | undefined, meta: RequestMeta = {}): SessionInfo | null {
    if (!token || token.length > 200) return null;
    const s = this.ctx.db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
    if (!s || s.revoked_at) return null;
    const now = this.ctx.clock.now();
    if (Date.parse(String(s.expires_at)) <= now.getTime()) return null;
    if (now.getTime() - Date.parse(String(s.created_at)) > ABSOLUTE_MAX_MS) return null;
    const u = this.userWithRole('u.id = ?', String(s.user_id));
    if (!u || u.status !== 'active' || Number(u.token_version) !== Number(s.token_version)) return null;

    if (now.getTime() - Date.parse(String(s.last_seen_at)) > TOUCH_INTERVAL_MS) {
      this.ctx.db.run(
        'UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = COALESCE(?, ip) WHERE id = ?',
        now.toISOString(), addMs(now, IDLE_TIMEOUT_MS).toISOString(), meta.ip ?? null, String(s.id),
      );
    }
    const user = this.toPublicUser(u);
    return { actor: this.actorFor(u, String(s.id), meta.ip), user, sessionId: String(s.id), mustChangePassword: user.mustChangePassword };
  }

  logout(token: string, meta: RequestMeta): void {
    this.ctx.tx(() => {
      const s = this.ctx.db.get('SELECT id, user_id FROM sessions WHERE token_hash = ?', sha256(token));
      if (!s) return;
      this.ctx.db.run("UPDATE sessions SET revoked_at = ?, revoke_reason = 'logout' WHERE id = ?", this.ctx.nowIso(), String(s.id));
      this.event(String(s.user_id), null, 'logout', meta);
    });
  }

  async changePassword(actor: Actor, raw: unknown, meta: RequestMeta): Promise<void> {
    const input = changePasswordSchema.parse(raw);
    if (!actor.userId) throw unauthorized();
    const u = this.ctx.db.get('SELECT * FROM users WHERE id = ?', actor.userId);
    if (!u) throw unauthorized();
    if (!(await verifyPassword(input.currentPassword, String(u.password_hash)))) {
      throw new AppError(400, 'BAD_CURRENT_PASSWORD', 'Senha atual incorreta.');
    }
    const strength = checkPasswordStrength(input.newPassword, [String(u.name), String(u.email)]);
    if (!strength.ok) throw badRequest(strength.problems.join(' '), 'WEAK_PASSWORD');
    if (await verifyPassword(input.newPassword, String(u.password_hash))) {
      throw badRequest('A nova senha deve ser diferente da atual.', 'SAME_PASSWORD');
    }
    const hash = await hashPassword(input.newPassword);
    this.ctx.tx(() => {
      this.ctx.db.run(
        'UPDATE users SET password_hash = ?, must_change_password = 0, version = version + 1, updated_at = ? WHERE id = ?',
        hash, this.ctx.nowIso(), actor.userId,
      );
      // Encerra as demais sessões do usuário; a atual continua válida.
      this.ctx.db.run(
        "UPDATE sessions SET revoked_at = ?, revoke_reason = 'password_changed' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL",
        this.ctx.nowIso(), actor.userId, actor.sessionId ?? '',
      );
      this.event(actor.userId, String(u.email), 'password_changed', meta);
      this.ctx.audit(actor, 'auth.password_changed', 'user', actor.userId);
    });
  }

  /** Invalida todas as sessões de um usuário (bloqueio, troca de permissões, reset). */
  revokeUserSessions(userId: string, reason: string): void {
    this.ctx.db.run(
      'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      this.ctx.nowIso(), reason, userId,
    );
    this.ctx.emit({ channel: 'system', type: 'session.revoked', data: { userId } });
  }

  history(userId: string, limit = 100) {
    return this.ctx.db.all(
      'SELECT event, ip, user_agent, detail, created_at FROM auth_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      userId, limit,
    );
  }

  activeSessions(userId: string) {
    return this.ctx.db.all(
      `SELECT id, device_label, ip, user_agent, created_at, last_seen_at FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`,
      userId, this.ctx.nowIso(),
    );
  }
}
