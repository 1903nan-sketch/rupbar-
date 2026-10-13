'use client';
import { LogIn } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setMsg({ kind: 'error', text: error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message });
    router.replace('/');
    router.refresh();
  };

  const reset = async () => {
    if (!email) return setMsg({ kind: 'error', text: 'Informe seu e-mail para redefinir a senha.' });
    const { error } = await supabaseBrowser().auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/auth/callback?next=/auth/nova-senha` });
    setMsg(error ? { kind: 'error', text: error.message } : { kind: 'ok', text: 'Enviamos um link de redefinição para o seu e-mail.' });
  };

  return (
    <div className="center-page">
      <form className="login-card" onSubmit={submit}>
        <div className="logo" style={{ width: 72, height: 72, fontSize: 28, margin: '0 auto' }}>RB</div>
        <div>
          <h1 style={{ fontSize: 28 }}>RupBar</h1>
          <p className="muted">Painel online do proprietário</p>
        </div>
        <div className="card stack" style={{ textAlign: 'left' }}>
          <div className="field"><label htmlFor="email">E-mail</label><input id="email" className="input large" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="pw">Senha</label><input id="pw" className="input large" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {msg && <div className={`banner ${msg.kind === 'error' ? 'danger' : 'success'}`}>{msg.text}</div>}
          <button type="submit" className="btn primary large block" disabled={busy}><LogIn size={18} /> {busy ? 'Entrando…' : 'Entrar'}</button>
          <button type="button" className="btn plain block" onClick={reset}>Esqueci minha senha</button>
        </div>
        <p className="small muted">Acesso exclusivo do proprietário. Funcionários usam o RupBar na rede do bar.</p>
        <div className="signature"><strong>RupBar</strong> by Ruptix</div>
      </form>
    </div>
  );
}
