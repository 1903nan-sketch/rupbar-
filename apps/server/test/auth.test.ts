import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createEnv, createStaff, OWNER, setupEstablishment, type TestEnv } from './helpers';

let env: TestEnv;
beforeEach(async () => {
  env = await createEnv();
});
afterEach(async () => {
  await env.app.close();
  env.s.close();
});

describe('configuração inicial', () => {
  it('cria estabelecimento, perfis, proprietário e categorias; login automático', async () => {
    const st = await new Client(env.app).ok('GET', '/api/setup/status');
    expect(st).toEqual({ configured: false, isLocal: true });
    const owner = await setupEstablishment(env);
    const me = await owner.ok('GET', '/api/auth/me');
    expect(me.user.roleKey).toBe('owner');
    expect(me.user.permissions).toContain('losses.confirm');
    const branding = await owner.ok('GET', '/api/branding');
    expect(branding).toMatchObject({ configured: true, tradeName: 'Bar da Marina', initials: 'BM', logoUrl: null });
    const cats = await owner.ok<{ name: string }[]>('GET', '/api/categories');
    expect(cats.map((c) => c.name)).toEqual(expect.arrayContaining(['Cervejas', 'Destilados', 'Essências', 'Carvão', 'Narguilés']));
    const roles = await owner.ok<{ key: string }[]>('GET', '/api/roles');
    expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(['owner', 'manager', 'cashier', 'waiter', 'kitchen']));
  });

  it('só pode ser executada uma vez e apenas no próprio PC', async () => {
    const remote = new Client(env.app, '192.168.0.23');
    const f = await remote.fail('POST', '/api/setup', { identity: { tradeName: 'X' }, owner: OWNER });
    expect(f.code).toBe('SETUP_LOCAL_ONLY');
    await setupEstablishment(env);
    const again = await new Client(env.app).fail('POST', '/api/setup', {
      identity: { tradeName: 'Outro' }, owner: { ...OWNER, email: 'x@y.com' },
    });
    expect(again.code).toBe('ALREADY_CONFIGURED');
  });

  it('rejeita senha fraca do proprietário', async () => {
    const f = await new Client(env.app).fail('POST', '/api/setup', {
      identity: { tradeName: 'Bar' }, owner: { name: 'Ana', email: 'ana@bar.com', password: '12345678' },
    });
    expect(f.status).toBe(400);
  });
});

describe('login e sessões', () => {
  it('senha errada gera erro genérico e bloqueio após 5 tentativas', async () => {
    await setupEstablishment(env);
    const c = new Client(env.app, '192.168.0.9');
    for (let i = 0; i < 5; i++) {
      const f = await c.fail('POST', '/api/auth/login', { email: OWNER.email, password: 'errada-123' });
      expect(f.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await c.fail('POST', '/api/auth/login', { email: OWNER.email, password: OWNER.password });
    expect(locked.code).toBe('LOCKED');
    env.clock.advance(6 * 60_000);
    await c.ok('POST', '/api/auth/login', { email: OWNER.email, password: OWNER.password });
    const unknown = await c.fail('POST', '/api/auth/login', { email: 'ninguem@bar.com', password: 'qualquer-1' });
    expect(unknown.code).toBe('INVALID_CREDENTIALS');
  });

  it('exige cabeçalho anti-CSRF em requisições que alteram dados', async () => {
    await setupEstablishment(env);
    const res = await env.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: OWNER.email, password: OWNER.password }, remoteAddress: '10.0.0.2',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF');
  });

  it('senha nunca é armazenada em texto puro', async () => {
    await setupEstablishment(env);
    const row = env.s.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', OWNER.email)!;
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    expect(row.password_hash).not.toContain(OWNER.password);
  });

  it('funcionário recebe senha temporária e precisa trocá-la no primeiro acesso', async () => {
    const owner = await setupEstablishment(env);
    const roles = await owner.ok<{ id: string; key: string }[]>('GET', '/api/roles');
    const waiterRole = roles.find((r) => r.key === 'waiter')!;
    const created = await owner.ok('POST', '/api/users', { name: 'João Garçom', email: 'joao@bar.com', roleId: waiterRole.id });
    expect(created.temporaryPassword).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{2}$/);
    const w = new Client(env.app, '192.168.0.31');
    const login = await w.ok('POST', '/api/auth/login', { email: 'joao@bar.com', password: created.temporaryPassword });
    expect(login.mustChangePassword).toBe(true);
    const blocked = await w.fail('GET', '/api/menu');
    expect(blocked.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await w.ok('POST', '/api/auth/change-password', { currentPassword: created.temporaryPassword, newPassword: 'Cerveja-Gelada-7' });
    await w.ok('GET', '/api/menu');
  });

  it('bloqueio e mudança de permissões invalidam as sessões do funcionário', async () => {
    const owner = await setupEstablishment(env);
    const waiter = await createStaff(env, owner, 'waiter', 'Pedro', 'pedro@bar.com');
    await waiter.ok('GET', '/api/menu');
    const users = await owner.ok<{ id: string; email: string }[]>('GET', '/api/users');
    const pedro = users.find((u) => u.email === 'pedro@bar.com')!;
    await owner.ok('PATCH', `/api/users/${pedro.id}`, { denies: ['hookah.rent'] });
    expect((await waiter.fail('GET', '/api/menu')).status).toBe(401);
    const relog = new Client(env.app, '192.168.0.50');
    await relog.ok('POST', '/api/auth/login', { email: 'pedro@bar.com', password: 'Senha-Forte-99' });
    const me = await relog.ok('GET', '/api/auth/me');
    expect(me.user.permissions).not.toContain('hookah.rent');
    await owner.ok('PATCH', `/api/users/${pedro.id}`, { status: 'blocked' });
    expect((await relog.fail('GET', '/api/menu')).status).toBe(401);
    const f = await relog.fail('POST', '/api/auth/login', { email: 'pedro@bar.com', password: 'Senha-Forte-99' });
    expect(f.code).toBe('USER_BLOCKED');
    const access = await owner.ok('GET', `/api/users/${pedro.id}/access`);
    expect(access.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['login_success', 'login_blocked']));
  });
});

describe('permissões', () => {
  it('somente o proprietário cria contas; gerente não registra perdas nem vê relatórios financeiros', async () => {
    const owner = await setupEstablishment(env);
    const manager = await createStaff(env, owner, 'manager', 'Gerente Ana', 'ana@bar.com');
    const roles = await owner.ok<{ id: string; key: string }[]>('GET', '/api/roles');
    expect((await manager.fail('POST', '/api/users', { name: 'X', email: 'x@bar.com', roleId: roles[0]!.id })).status).toBe(403);
    expect((await manager.fail('GET', '/api/reports/sales?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z')).status).toBe(403);
    const dash = await manager.ok('GET', '/api/dashboard');
    expect(dash.financial).toBeNull();
    const ownerDash = await owner.ok('GET', '/api/dashboard');
    expect(ownerDash.financial).not.toBeNull();
  });

  it('permissões exclusivas do proprietário não podem ser concedidas a cargos personalizados', async () => {
    const owner = await setupEstablishment(env);
    const role = await owner.ok('POST', '/api/roles', { name: 'Supervisor', permissions: ['cash.open', 'losses.confirm', 'users.manage'] });
    const roles = await owner.ok<{ id: string; permissions: string[] }[]>('GET', '/api/roles');
    expect(roles.find((r) => r.id === role.id)!.permissions).toEqual(['cash.open']);
  });

  it('garçom não acessa caixa nem cadastro de produtos', async () => {
    const owner = await setupEstablishment(env);
    const waiter = await createStaff(env, owner, 'waiter', 'Lia', 'lia@bar.com');
    expect((await waiter.fail('POST', '/api/cash/open', { openingBalanceCents: 0 })).status).toBe(403);
    expect((await waiter.fail('GET', '/api/users')).status).toBe(403);
    expect((await waiter.fail('POST', '/api/categories', { name: 'Nova' })).status).toBe(403);
  });
});
