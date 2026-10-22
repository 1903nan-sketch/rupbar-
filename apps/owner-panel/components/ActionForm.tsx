'use client';
import { CircleAlert, CircleCheck, Send } from 'lucide-react';
import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import type { ActionState } from '@/app/(panel)/acoes';

/**
 * Formulário de uma ação do painel: envia para o PC do bar e mostra o
 * resultado do envio (o resultado da aplicação aparece em "Ações enviadas").
 */
export function ActionForm({ action, children, submit, pending = 'Enviando…', icon, variant = 'primary', block, compact, reset = true, confirm }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>;
  children?: ReactNode;
  submit: ReactNode;
  pending?: string;
  /** Ícone já montado (ex.: <Lock size={17} />): componentes não passam do servidor para o navegador. */
  icon?: ReactNode;
  variant?: 'primary' | 'danger' | 'ghost';
  block?: boolean;
  /** Botão pequeno, sem a caixa de resultado embaixo (ações de linha). */
  compact?: boolean;
  /** Limpa os campos depois de enviar. */
  reset?: boolean;
  /** Pergunta antes de enviar (ações que não têm volta). */
  confirm?: string;
}) {
  const [state, formAction, busy] = useActionState<ActionState | null, FormData>(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && reset) ref.current?.reset();
  }, [state, reset]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={compact ? 'action-inline' : 'stack action-form'}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <button className={`btn ${variant} ${compact ? 'small' : 'large'} ${block ? 'block' : ''}`} type="submit" disabled={busy}>
        {busy ? <span className="spinner" aria-hidden="true" /> : (icon ?? <Send size={compact ? 14 : 17} aria-hidden="true" />)}
        {busy ? pending : submit}
      </button>
      {state && (!compact || !state.ok) && (
        <div className={`banner ${state.ok ? 'success' : 'danger'}`} role={state.ok ? 'status' : 'alert'}>
          <span className="banner-icon" aria-hidden="true">{state.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}</span>
          <span>{state.message}</span>
        </div>
      )}
    </form>
  );
}
