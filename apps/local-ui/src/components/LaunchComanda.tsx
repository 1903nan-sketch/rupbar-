import { ArrowLeft, ArrowRight, ClipboardPlus, Delete, ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, requestId } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useSession } from '../lib/session';
import '../styles/quick.css';
import { OrderComposer } from './OrderComposer';
import { Button, Input, useToast } from './ui';

interface ComandaSummary {
  id: string;
  number: number;
  cardNumber: number | null;
  displayNumber: number | null;
  customerName: string;
  table: string | null;
  total: number;
  remaining: number;
  itemCount: number;
}

/**
 * "Lançar na comanda" sem procurar no menu: digita o número do cartão,
 * confere o cliente e escolhe os itens. Cartão livre → abre a comanda na hora.
 */
export function LaunchComanda({ onClose, initialNumber }: { onClose: () => void; initialNumber?: number }) {
  const toast = useToast();
  const { can } = useSession();
  const [digits, setDigits] = useState(initialNumber ? String(initialNumber) : '');
  const [comanda, setComanda] = useState<ComandaSummary | null>(null);
  const [notFound, setNotFound] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const openKey = useRef<string | null>(null);

  const lookup = async (raw = digits) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return;
    setBusy(true);
    setNotFound(null);
    try {
      const c = await api.get<ComandaSummary | null>(`/api/comandas/by-number/${n}`);
      if (c) setComanda(c);
      else setNotFound(n);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialNumber) void lookup(String(initialNumber));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = async () => {
    if (notFound === null) return;
    openKey.current ??= requestId();
    setBusy(true);
    try {
      const c = await api.post<ComandaSummary>('/api/comandas', { cardNumber: notFound, customerName: name.trim(), clientRequestId: openKey.current });
      toast.success(`Comanda ${notFound} aberta`);
      setComanda(c);
      setNotFound(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const press = (k: string) => {
    setNotFound(null);
    setDigits((d) => (k === 'del' ? d.slice(0, -1) : (d + k).replace(/^0+/, '').slice(0, 5)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.option-chooser')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay quick-overlay" role="dialog" aria-modal="true" aria-label="Lançar na comanda">
      <div className={`quick-sale modal ${comanda ? '' : 'launch-small'}`} style={comanda ? undefined : { width: 'min(460px, 100%)', height: 'auto' }}>
        <header className="quick-head">
          <div className="row">
            {comanda && <Button variant="plain" icon={<ArrowLeft size={20} />} aria-label="Trocar comanda" onClick={() => { setComanda(null); setDigits(''); }} />}
            <span className="icon-chip"><ClipboardPlus size={20} /></span>
            <div>
              <h2>Lançar na comanda</h2>
              <div className="small muted">{comanda ? 'Toque nos produtos e envie.' : 'Digite o número do cartão ou da comanda.'}</div>
            </div>
          </div>
          <Button variant="plain" icon={<X size={20} />} aria-label="Fechar" onClick={onClose} />
        </header>

        {comanda ? (
          <div className="stack" style={{ padding: '14px 18px 18px', overflowY: 'auto' }}>
            <div className="launch-found pop-in">
              <span className="card-number-badge">{comanda.displayNumber ?? comanda.number}</span>
              <div className="grow">
                <div className="strong" style={{ fontSize: 18 }}>{comanda.customerName || 'Sem nome'}</div>
                <div className="small muted">
                  {comanda.table ? `Mesa ${comanda.table} · ` : ''}{comanda.itemCount} {comanda.itemCount === 1 ? 'item' : 'itens'} · consumo {formatBRL(comanda.total)}
                </div>
              </div>
              <Link to={`/comandas/${comanda.id}`} className="btn plain small" onClick={onClose}><ExternalLink size={15} /> Abrir</Link>
            </div>
            <OrderComposer
              comandaId={comanda.id}
              onSent={async () => {
                const c = await api.get<ComandaSummary | null>(`/api/comandas/by-number/${comanda.displayNumber ?? comanda.number}`).catch(() => null);
                if (c) setComanda(c);
              }}
            />
          </div>
        ) : (
          <form className="stack" style={{ padding: '16px 18px 20px' }} onSubmit={(e) => { e.preventDefault(); void lookup(); }}>
            <div className="launch-number">
              <Input
                inputMode="numeric"
                autoFocus
                aria-label="Número da comanda"
                placeholder="Nº"
                value={digits}
                onChange={(e) => { setNotFound(null); setDigits(e.target.value.replace(/\D/g, '').slice(0, 5)); }}
              />
              <Button type="submit" variant="primary" size="large" loading={busy} disabled={!digits} icon={<ArrowRight size={20} />} aria-label="Buscar" />
            </div>
            <div className="launch-keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => <button key={k} type="button" onClick={() => press(k)}>{k}</button>)}
              <button type="button" onClick={() => press('del')} aria-label="Apagar"><Delete size={20} /></button>
              <button type="button" onClick={() => press('0')}>0</button>
              <button type="submit" aria-label="Buscar" style={{ color: 'var(--accent)' }}><ArrowRight size={22} /></button>
            </div>
            {notFound !== null && (
              <div className="owner-zone pop-in stack" style={{ gap: 10, borderStyle: 'solid' }}>
                <div><strong>Nenhuma comanda aberta com o número {notFound}.</strong></div>
                {can('comandas.open') ? (
                  <>
                    <Input placeholder="Nome do cliente (opcional)" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
                    <Button variant="primary" loading={busy} onClick={openNew}>Abrir comanda {notFound}</Button>
                  </>
                ) : (
                  <div className="small muted">Peça a quem pode abrir comandas.</div>
                )}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
