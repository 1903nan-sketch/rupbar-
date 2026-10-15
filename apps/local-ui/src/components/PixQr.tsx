import { CheckCircle2, Copy, QrCode, Settings } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import '../styles/pix.css';
import { Button, ErrorBox, Spinner, useToast } from './ui';

/** Resposta de GET /api/pix/payload. */
export interface PixCharge {
  payload: string;
  amountCents: number;
  txid: string;
  merchantName: string;
  merchantCity: string;
  keyType: string;
  keyLabel: string;
  key: string;
}

/**
 * QR Code em SVG gerado localmente (sem serviço externo): nítido em qualquer
 * tamanho e densidade de tela. A biblioteca é carregada só quando o QR aparece,
 * para não pesar no carregamento inicial do celular do garçom.
 */
export function usePixQrImage(payload: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!payload) return setSrc(null);
    let alive = true;
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#000000', light: '#ffffff' } }))
      .then((svg) => alive && setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [payload]);
  return src;
}

/**
 * Copia texto para a área de transferência. Celulares acessam o PC do bar por
 * http na rede local (sem contexto seguro), onde a Clipboard API não existe:
 * nesse caso usa o método antigo com um campo temporário.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* tenta o método antigo */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/** QR + valor + botão "Copiar código Pix" para um payload já gerado. */
export function PixQrView({ payload, amountCents, merchantName, size = 240, note }: {
  payload: string | null;
  amountCents: number;
  merchantName?: string;
  size?: number;
  note?: ReactNode;
}) {
  const src = usePixQrImage(payload);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => setCopied(null), [payload]);

  const copy = async () => {
    if (!payload) return;
    const ok = await copyText(payload);
    setCopied(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), ok ? 2500 : 6000);
  };

  return (
    <div className="pix-qr" style={{ '--pix-qr-size': `${size}px` } as CSSProperties}>
      <div className="pix-qr-frame">
        {src ? <img src={src} alt={`QR Code Pix${amountCents > 0 ? ` de ${formatBRL(amountCents)}` : ''}`} /> : <div className="pix-qr-placeholder"><Spinner /></div>}
        <span className="pix-qr-badge"><QrCode size={12} /> Pix</span>
      </div>
      {amountCents > 0 ? <div className="pix-qr-amount">{formatBRL(amountCents)}</div> : <div className="small muted" style={{ marginTop: 8 }}>Sem valor: o cliente digita o valor no app do banco.</div>}
      {merchantName && <div className="small muted">Recebedor: <strong style={{ color: 'var(--text)' }}>{merchantName}</strong></div>}
      <div className="pix-qr-actions">
        <Button variant="primary" size="large" className={copied === 'ok' ? 'copied' : ''} disabled={!payload} icon={copied === 'ok' ? <CheckCircle2 size={18} /> : <Copy size={18} />} onClick={copy}>
          {copied === 'ok' ? 'Código copiado!' : 'Copiar código Pix'}
        </Button>
        <span className="tiny" aria-live="polite" style={{ color: copied === 'fail' ? 'var(--red)' : 'var(--text-3)' }}>
          {copied === 'fail' ? 'Não foi possível copiar automaticamente. Abra o código abaixo, selecione e copie.' : copied === 'ok' ? 'Cole no app do banco em “Pix copia e cola”.' : ' '}
        </span>
      </div>
      {payload && (
        <details className="pix-qr-details" open={copied === 'fail' || undefined}>
          <summary>Ver código copia e cola</summary>
          <div className="pix-qr-code">{payload}</div>
        </details>
      )}
      {note && <div className="small muted pix-qr-note">{note}</div>}
    </div>
  );
}

/**
 * A chave está salva, mas o interruptor "Gerar Pix copia e cola" ficou
 * desligado. Quem gerencia as configurações liga ali mesmo, sem sair do caixa.
 */
function PixDisabled({ onEnabled }: { onEnabled: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const manage = can('settings.manage');
  const enable = async () => {
    setBusy(true);
    try {
      const cfg = await api.get<Record<string, unknown>>('/api/settings/pix');
      await api.put('/api/settings/pix', { ...cfg, enabled: true });
      toast.success('Pix ligado: o QR Code já aparece no pagamento e na conta impressa');
      onEnabled();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner warning">
      <QrCode size={18} style={{ flex: 'none', marginTop: 2 }} />
      <div className="grow">
        <strong>O Pix copia e cola está desligado.</strong>{' '}
        {manage ? 'A chave está salva, falta ligar para o QR Code aparecer aqui.' : 'Peça ao proprietário para ligar em Configurações → Pix.'}
      </div>
      {manage && <Button size="small" variant="primary" loading={busy} onClick={enable}>Ligar Pix</Button>}
    </div>
  );
}

/** Evita uma requisição a cada tecla enquanto o valor é digitado. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * QR Code Pix do valor informado, gerado pelo PC do bar com a chave configurada.
 * Com `comandaId`, o código leva o número da comanda (aparece no extrato).
 */
export function PixQr({ amountCents, comandaId, size }: { amountCents: number; comandaId?: string; size?: number }) {
  const { can } = useSession();
  const wanted = Math.max(0, Math.round(amountCents || 0));
  const amount = useDebounced(wanted, 300);
  const { data, error, reload } = useLoad(
    (signal) => (amount > 0 ? api.get<PixCharge>(`/api/pix/payload${qs({ amountCents: amount, comandaId })}`, signal) : Promise.resolve(null)),
    [amount, comandaId],
  );
  useRealtime('pix.updated', () => void reload());

  if (error?.code === 'PIX_DISABLED') return <PixDisabled onEnabled={reload} />;
  if (error?.code === 'PIX_NOT_CONFIGURED') {
    return (
      <div className="banner warning">
        <QrCode size={18} style={{ flex: 'none', marginTop: 2 }} />
        <div className="grow">
          <strong>Pix copia e cola não configurado.</strong>{' '}
          {can('settings.manage') ? 'Cadastre a chave Pix do bar para mostrar o QR Code aqui.' : 'Peça ao proprietário para cadastrar a chave Pix do bar em Configurações.'}
        </div>
        {can('settings.manage') && <Link to="/configuracoes/pix" className="btn small"><Settings size={14} /> Configurar Pix</Link>}
      </div>
    );
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (wanted <= 0) return <div className="banner"><QrCode size={18} style={{ flex: 'none', marginTop: 2 }} /> Informe o valor para gerar o QR Code Pix.</div>;
  // Enquanto o valor muda, nunca mostra um QR de outro valor.
  const current = data && data.amountCents === wanted ? data : null;
  return (
    <PixQrView
      payload={current?.payload ?? null}
      amountCents={wanted}
      merchantName={current?.merchantName}
      size={size}
      note="Pix estático: o sistema não recebe aviso do banco. Confira o crédito no app do banco antes de confirmar o pagamento."
    />
  );
}
