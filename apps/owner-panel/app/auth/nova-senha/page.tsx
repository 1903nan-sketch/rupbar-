'use client';
import { checkPasswordStrength } from '@rupbar/core';
import { Check, CircleAlert, Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { supabaseBrowser } from '@/lib/supabase/client';

const RULES: { label: string; test: (pw: string) => boolean }[] = [
  { label: 'Pelo menos 8 caracteres', test: (pw) => pw.length >= 8 },
  { label: 'Ao menos uma letra', test: (pw) => /[a-zA-Z]/.test(pw) },
  { label: 'Ao menos um número', test: (pw) => /\d/.test(pw) },
];

export default function NewPasswordPage() {
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const strength = checkPasswordStrength(pw);
  const passed = RULES.filter((r) => r.test(pw)).length + (pw && strength.ok ? 1 : 0);
  const level = !pw ? 0 : strength.ok ? 4 : Math.min(3, passed);

  return (
    <div className="auth single">
      <section className="auth-panel">
        <form
          className="card auth-card"
          aria-labelledby="np-title"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!strength.ok) return setMsg(strength.problems.join(' '));
            setBusy(true);
            const { error } = await supabaseBrowser().auth.updateUser({ password: pw });
            setBusy(false);
            if (error) return setMsg(error.message);
            router.replace('/');
          }}
        >
          <div className="auth-card-head center">
            <div className="brand-orb sm">
              <BrandMark size={52} id="bm-np" />
            </div>
            <h1 id="np-title">Nova senha</h1>
            <p className="muted small">Escolha uma senha forte para o painel do RupBar.</p>
          </div>
          <div className="field">
            <label htmlFor="pw">Nova senha</label>
            <div className="input-icon">
              <Lock size={17} aria-hidden="true" />
              <input id="pw" className="input large" type={show ? 'text' : 'password'} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="pw-rules" />
              <button type="button" className="input-action" onClick={() => setShow((v) => !v)} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={show}>
                {show ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <div className={`strength l${level}`} aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <ul id="pw-rules" className="rules">
            {RULES.map((r) => {
              const ok = r.test(pw);
              return (
                <li key={r.label} className={ok ? 'ok' : ''}>
                  <span className="rule-icon" aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  {r.label}
                  <span className="sr-only">{ok ? ' (atendido)' : ' (pendente)'}</span>
                </li>
              );
            })}
          </ul>
          {msg && (
            <div className="banner danger" role="alert">
              <span className="banner-icon" aria-hidden="true">
                <CircleAlert size={18} />
              </span>
              <span>{msg}</span>
            </div>
          )}
          <button className="btn primary large block shine" type="submit" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <KeyRound size={18} aria-hidden="true" />} Salvar
          </button>
        </form>
        <div className="signature">
          <strong>RupBar</strong> by Ruptix
        </div>
      </section>
    </div>
  );
}
