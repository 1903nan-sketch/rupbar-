import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import {
  cloneElement, isValidElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../lib/api';
import { fmtDecimal, formatBRL, parseBRL, parseDecimal } from '../lib/format';

// ---------------------------------------------------------------- botões

type Variant = 'default' | 'primary' | 'danger' | 'success' | 'plain';
export function Button({
  variant = 'default', size, block, icon, loading, children, className = '', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'small' | 'large'; block?: boolean; icon?: ReactNode; loading?: boolean }) {
  const cls = ['btn', variant !== 'default' ? variant : '', size ?? '', block ? 'block' : '', !children && icon ? 'icon' : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest} disabled={rest.disabled || loading}>
      {loading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- formulários

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  const generatedId = useId();
  const control = isValidElement<{ id?: string }>(children) &&
    [Input, Select, Textarea, MoneyInput, DecimalInput, 'input', 'select', 'textarea'].includes(children.type as typeof Input);
  const id = control ? children.props.id ?? generatedId : undefined;
  return (
    <div className={`field ${className ?? ''}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {control ? cloneElement(children, { id }) : children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement> & { large?: boolean }) {
  const { large, className = '', ...rest } = props;
  return <input className={`input ${large ? 'large' : ''} ${className}`} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select className={`select ${className}`} {...rest} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="row between" style={{ gap: 16, padding: '6px 0' }}>
      {(label || description) && (
        <label htmlFor={id} className="grow" style={{ cursor: 'pointer' }}>
          <div style={{ fontWeight: 550 }}>{label}</div>
          {description && <div className="small muted">{description}</div>}
        </label>
      )}
      <label className="switch">
        <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </label>
    </div>
  );
}

/** Campo de dinheiro: aceita "12,50"; devolve centavos (ou null). */
export function MoneyInput({ value, onChange, placeholder = '0,00', autoFocus, large, id }: { value: number | null; onChange: (cents: number | null) => void; placeholder?: string; autoFocus?: boolean; large?: boolean; id?: string }) {
  const [text, setText] = useState(value === null ? '' : formatBRL(value).replace('R$ ', ''));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(value === null ? '' : formatBRL(value).replace('R$ ', ''));
      last.current = value;
    }
  }, [value]);
  return (
    <div className="input-group">
      <span className="prefix">R$</span>
      <input
        id={id}
        className={`input num ${large ? 'large' : ''}`}
        inputMode="decimal"
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          const c = parseBRL(e.target.value);
          last.current = c;
          onChange(c);
        }}
      />
    </div>
  );
}

/** Quantidade decimal (ex.: "1,5" L). Devolve número na unidade exibida. */
export function DecimalInput({ value, onChange, suffix, placeholder, autoFocus, id }: { value: number | null; onChange: (v: number | null) => void; suffix?: string; placeholder?: string; autoFocus?: boolean; id?: string }) {
  const [text, setText] = useState(value === null ? '' : fmtDecimal(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(value === null ? '' : fmtDecimal(value));
      last.current = value;
    }
  }, [value]);
  return (
    <div className="input-group">
      <input
        className="input num"
        id={id}
        inputMode="decimal"
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        style={suffix ? { paddingRight: 44 } : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseDecimal(e.target.value);
          last.current = n;
          onChange(n);
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; hidden?: boolean }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.filter((o) => !o.hidden).map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- superfícies

export function Card({ title, actions, children, className = '', flush, tight }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean; tight?: boolean }) {
  return (
    <section className={`card ${flush ? 'flush' : ''} ${tight ? 'tight' : ''} ${className}`}>
      {(title || actions) && (
        <div className="card-title" style={flush ? { padding: '16px 16px 0' } : undefined}>
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

export function Badge({ color, children }: { color?: 'green' | 'orange' | 'red' | 'blue' | 'purple' | 'accent'; children: ReactNode }) {
  return <span className={`badge ${color ?? ''}`}>{children}</span>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="strong" style={{ color: 'var(--text)' }}>{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="empty">
      <Spinner />
      <span className="small">{label}</span>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="banner danger">
      <AlertCircle size={18} style={{ color: 'var(--red)', flex: 'none', marginTop: 2 }} />
      <div className="grow">{msg}</div>
      {onRetry && <Button size="small" onClick={onRetry}>Tentar novamente</Button>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2 style={{ fontSize: 20 }}>{title}</h2>
          <Button variant="plain" icon={<X size={18} />} aria-label="Fechar" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}
const ToastCtx = createContext<{ push: (kind: Toast['kind'], text: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast glass ${t.kind}`}>
            <span className="icon">{t.kind === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('ToastProvider ausente');
  return {
    success: (t: string) => c.push('success', t),
    error: (e: unknown) => c.push('error', e instanceof ApiError || e instanceof Error ? e.message : String(e)),
    info: (t: string) => c.push('info', t),
  };
}

// ---------------------------------------------------------------- confirmação

export function Confirm({ title, message, confirmLabel = 'Confirmar', danger, onConfirm, onClose, children }: {
  title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<unknown> | void; onClose: () => void; children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            className={danger ? 'solid' : ''}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        {message && <p className="muted">{message}</p>}
        {children}
      </div>
    </Modal>
  );
}
