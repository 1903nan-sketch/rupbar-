import { checkPasswordStrength } from '@rupbar/core';
import { KeyRound, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo, RupbarSignature } from '../components/brand';
import { Button, Card, ErrorBox, Field, Input, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

/** Para onde cada perfil vai após o login (celular do garçom vai para /m). */
export function homeFor(perms: string[], width = window.innerWidth): string {
  const small = width < 900;
  if (perms.includes('kitchen.view') && !perms.includes('comandas.view')) return '/producao';
  if (small && perms.includes('orders.create')) return '/m';
  return '/';
}

export function LoginPage() {
  const { branding, login } = useSession();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(email, password);
      nav(u.mustChangePassword ? '/minha-senha' : homeFor(u.permissions), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      {branding?.coverUrl && <div className="login-cover" style={{ backgroundImage: `url(${branding.coverUrl})` }} />}
      <form className="login-card" onSubmit={submit}>
        <div style={{ margin: '0 auto' }}>
          <Logo branding={branding} size={84} />
        </div>
        <div>
          <h1 style={{ fontSize: 28 }}>{branding?.tradeName ?? 'RupBar'}</h1>
          <p className="muted">Entre com seu e-mail e senha</p>
        </div>
        <Card>
          <div className="stack" style={{ textAlign: 'left' }}>
            <Field label="E-mail">
              <Input large type="email" autoComplete="username" autoCapitalize="none" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Senha">
              <Input large type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <ErrorBox error={error} />}
            <Button type="submit" variant="primary" size="large" block loading={busy} icon={<LogIn size={18} />}>Entrar</Button>
          </div>
        </Card>
        <p className="small muted">Esqueceu a senha? Peça ao proprietário para redefini-la.</p>
        <RupbarSignature />
      </form>
    </div>
  );
}

export function ChangePasswordPage() {
  const { user, refresh } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strength = checkPasswordStrength(form.next, [user?.name ?? '', user?.email ?? '']);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!strength.ok) return setError(strength.problems.join(' '));
    if (form.next !== form.confirm) return setError('As senhas não conferem.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/change-password', { currentPassword: form.current, newPassword: form.next });
      await refresh();
      toast.success('Senha alterada.');
      nav(homeFor(user?.permissions ?? []), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <form className="login-card" onSubmit={submit}>
        <KeyRound size={40} style={{ margin: '0 auto', color: 'var(--accent)' }} />
        <div>
          <h1 style={{ fontSize: 26 }}>{user?.mustChangePassword ? 'Crie sua senha' : 'Alterar senha'}</h1>
          <p className="muted">{user?.mustChangePassword ? 'Você entrou com uma senha temporária. Defina uma senha pessoal para continuar.' : 'Sua nova senha encerra as outras sessões abertas.'}</p>
        </div>
        <Card>
          <div className="stack" style={{ textAlign: 'left' }}>
            <Field label={user?.mustChangePassword ? 'Senha temporária' : 'Senha atual'}>
              <Input type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
            </Field>
            <Field label="Nova senha" hint="Mínimo de 8 caracteres, com letras e números.">
              <Input type="password" autoComplete="new-password" required value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
            </Field>
            <Field label="Confirme a nova senha">
              <Input type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
            </Field>
            {error && <ErrorBox error={error} />}
            <Button type="submit" variant="primary" size="large" block loading={busy}>Salvar senha</Button>
            {!user?.mustChangePassword && <Button variant="plain" block onClick={() => nav(-1)}>Cancelar</Button>}
          </div>
        </Card>
      </form>
    </div>
  );
}
