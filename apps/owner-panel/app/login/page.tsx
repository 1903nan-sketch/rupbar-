'use client';
import { Boxes, ChartSpline, CircleAlert, CircleCheck, Eye, EyeOff, Lock, LogIn, Mail, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { supabaseBrowser } from '@/lib/supabase/client';

const FEATURES = [
  { icon: ChartSpline, title: 'Vendas ao vivo', text: 'Faturamento, ticket médio e formas de pagamento a cada minuto.' },
  { icon: Boxes, title: 'Estoque sob controle', text: 'Alertas de mínimo e registro de perdas de onde você estiver.' },
  { icon: WifiOff, title: 'Nunca para', text: 'O bar continua funcionando sem internet; os dados chegam depois.' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
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
    <div className="auth">
      <section className="auth-hero" aria-labelledby="auth-title">
        <div className="auth-brand">
          <div className="brand-orb">
            <BrandMark size={64} id="bm-login" />
          </div>
          <div>
            <div className="brand-name">RupBar</div>
            <div className="brand-by">by Ruptix</div>
          </div>
        </div>
        <h1 id="auth-title" className="auth-title">
          Seu bar <span className="gradient-text">em tempo real</span>, onde você estiver.
        </h1>
        <p className="auth-lead">Acompanhe vendas, comandas, estoque, perdas e caixas do seu estabelecimento pelo celular ou pelo computador.</p>
        <ul className="auth-features">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title}>
              <span className="feature-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span>
                <strong>{title}</strong>
                <span className="muted"> — {text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="auth-panel">
        <form className="card auth-card" onSubmit={submit} aria-labelledby="login-title">
          <div className="auth-card-head">
            <h2 id="login-title">Entrar no painel</h2>
            <p className="muted small">Painel online do proprietário</p>
          </div>
          <div className="field">
            <label htmlFor="email">E-mail</label>
            <div className="input-icon">
              <Mail size={17} aria-hidden="true" />
              <input id="email" className="input large" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="pw">Senha</label>
            <div className="input-icon">
              <Lock size={17} aria-hidden="true" />
              <input id="pw" className="input large" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="input-action" onClick={() => setShow((v) => !v)} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={show}>
                {show ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
          </div>
          {msg && (
            <div className={`banner ${msg.kind === 'error' ? 'danger' : 'success'}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
              <span className="banner-icon" aria-hidden="true">
                {msg.kind === 'error' ? <CircleAlert size={18} /> : <CircleCheck size={18} />}
              </span>
              <span>{msg.text}</span>
            </div>
          )}
          <button type="submit" className="btn primary large block shine" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <LogIn size={18} aria-hidden="true" />} {busy ? 'Entrando…' : 'Entrar'}
          </button>
          <button type="button" className="btn ghost block" onClick={reset}>
            Esqueci minha senha
          </button>
        </form>
        <p className="small muted auth-note">Acesso exclusivo do proprietário. Funcionários usam o RupBar na rede do bar.</p>
        <div className="signature">
          <strong>RupBar</strong> by Ruptix
        </div>
      </section>
    </div>
  );
}
