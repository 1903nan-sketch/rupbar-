'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { checkPasswordStrength } from '@rupbar/core';
import { supabaseBrowser } from '@/lib/supabase/client';

export default function NewPasswordPage() {
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const strength = checkPasswordStrength(pw);
  return (
    <div className="center-page">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!strength.ok) return setMsg(strength.problems.join(' '));
          const { error } = await supabaseBrowser().auth.updateUser({ password: pw });
          if (error) return setMsg(error.message);
          router.replace('/');
        }}
      >
        <h1 style={{ fontSize: 26 }}>Nova senha</h1>
        <div className="card stack" style={{ textAlign: 'left' }}>
          <div className="field"><label htmlFor="pw">Nova senha</label><input id="pw" className="input large" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          {msg && <div className="banner danger">{msg}</div>}
          <button className="btn primary large block" type="submit">Salvar</button>
        </div>
      </form>
    </div>
  );
}
