import { Check, Info, Package, Plus, RefreshCw, Users, Wind } from 'lucide-react';
import { useState } from 'react';
import type { Menu, MenuItem } from '../../components/MenuPicker';
import { Button, ErrorBox, Input, Loading, Switch, useToast } from '../../components/ui';
import { api, requestId } from '../../lib/api';
import { formatBRL, formatQty } from '../../lib/format';
import { useLoad } from '../../lib/hooks';
import { useRealtime } from '../../lib/realtime';
import '../../styles/hookah.css';

interface Supply {
  id: string;
  name: string;
  stockQty: number;
  stockTracked: boolean;
}
interface Panel {
  pricing: { rentalCents: number; roshSwapCents: number; ownRoshCents: number };
  sessions: { id: string; mode: 'legacy' | 'house' | 'own'; roshCount: number; title: string; chargedCents: number | null }[];
  devices: { id: string; code: string; model: string }[];
  essences: Supply[];
  coals: Supply[];
  gramsPerRosh: number;
  allowNegativeStock: boolean;
}

/** Carvão por rosh: 3 no primeiro (acender), 2 nas trocas. */
const COAL_START = 3;
const COAL_SWAP = 2;

type Sheet = { kind: 'rent' } | { kind: 'own' } | { kind: 'rosh'; sessionId: string; title: string; own: boolean } | { kind: 'pack' };

/** Divide a porção da casa entre os sabores escolhidos (em milésimos de grama). */
function essencesPayload(ids: string[], gramsPerRosh: number) {
  if (!ids.length) return [];
  const each = Math.floor(gramsPerRosh / ids.length);
  return ids.map((productId, i) => ({ productId, qty: i === 0 ? gramsPerRosh - each * (ids.length - 1) : each }));
}

/**
 * Narguilé no celular do garçom: alugar, trocar o rosh, narguilé do cliente e
 * pacote de essência fechado. Tudo é lançado na comanda na hora e não há
 * devolução: as locações terminam sozinhas quando a comanda é encerrada.
 */
export function MobileHookah({ comandaId, onChanged }: { comandaId: string; onChanged: () => void }) {
  const { data, error, reload } = useLoad(() => api.get<Panel>(`/api/comandas/${comandaId}/hookah`), [comandaId]);
  const menu = useLoad(() => api.get<Menu>('/api/menu'));
  useRealtime(['hookah', 'comandas'], () => void reload());
  const [sheet, setSheet] = useState<Sheet | null>(null);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const essenceCat = new Set((menu.data?.categories ?? []).filter((c) => c.name === 'Essências').map((c) => c.id));
  const packs = (menu.data?.items ?? []).filter((i) => essenceCat.has(i.categoryId) || /ess[eê]ncia/i.test(i.productName));
  const done = () => {
    setSheet(null);
    void reload();
    onChanged();
  };

  if (sheet) {
    return sheet.kind === 'pack'
      ? <PackSheet comandaId={comandaId} packs={packs} onCancel={() => setSheet(null)} onDone={done} />
      : <LaunchSheet sheet={sheet} panel={data} comandaId={comandaId} onCancel={() => setSheet(null)} onDone={done} />;
  }

  const p = data.pricing;
  return (
    <div className="mhookah stack">
      {data.sessions.length > 0 && (
        <section className="stack" aria-label="Narguilés nesta comanda">
          {data.sessions.map((s) => (
            <div key={s.id} className="card mhookah-session pop-in">
              <div className="row between">
                <div style={{ minWidth: 0 }}>
                  <div className="strong ellipsis" style={{ fontSize: 17 }}>{s.title}</div>
                  <div className="small muted">{s.roshCount} rosh{s.chargedCents !== null && <> · {formatBRL(s.chargedCents)} lançado</>}</div>
                </div>
                <Wind size={22} className="muted" aria-hidden="true" />
              </div>
              {s.mode !== 'legacy' && (
                <Button variant="primary" size="large" block icon={<RefreshCw size={18} />}
                  onClick={() => setSheet({ kind: 'rosh', sessionId: s.id, title: s.title, own: s.mode === 'own' })}>
                  {s.mode === 'own' ? 'Novo rosh' : 'Trocar rosh'} · {formatBRL(s.mode === 'own' ? p.ownRoshCents : p.roshSwapCents)}
                </Button>
              )}
            </div>
          ))}
        </section>
      )}

      <button type="button" className="mhookah-action primary" onClick={() => setSheet({ kind: 'rent' })}>
        <span className="mhookah-icon"><Wind size={24} /></span>
        <span className="grow">
          <strong>Alugar narguilé</strong>
          <span>Essência e carvão inclusos</span>
        </span>
        <span className="num mhookah-price">{formatBRL(p.rentalCents)}</span>
      </button>
      <button type="button" className="mhookah-action" onClick={() => setSheet({ kind: 'own' })}>
        <span className="mhookah-icon"><Users size={22} /></span>
        <span className="grow">
          <strong>Narguilé do cliente</strong>
          <span>Cliente trouxe o aparelho: essência e carvão</span>
        </span>
        <span className="num mhookah-price">{formatBRL(p.ownRoshCents)}</span>
      </button>
      <button type="button" className="mhookah-action" onClick={() => setSheet({ kind: 'pack' })} disabled={!packs.length}>
        <span className="mhookah-icon"><Package size={22} /></span>
        <span className="grow">
          <strong>Pacote de essência fechado</strong>
          <span>{packs.length ? 'O cliente leva o pacote' : 'Nenhum pacote à venda no cardápio'}</span>
        </span>
      </button>
      <p className="small muted row" style={{ alignItems: 'flex-start' }}>
        <Info size={15} style={{ flex: 'none', marginTop: 2 }} />
        <span>Não precisa devolver nem encerrar o narguilé: ele termina sozinho quando a comanda for encerrada.</span>
      </p>
    </div>
  );
}

/** Aluguel, narguilé do cliente ou troca de rosh: escolhe o sabor e lança. */
function LaunchSheet({ sheet, panel, comandaId, onCancel, onDone }: {
  sheet: Exclude<Sheet, { kind: 'pack' }>; panel: Panel; comandaId: string; onCancel: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [flavors, setFlavors] = useState<string[]>([]);
  const [device, setDevice] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [charge, setCharge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);
  const p = panel.pricing;
  const coalWanted = sheet.kind === 'rosh' ? COAL_SWAP : COAL_START;
  /** Tem saldo para baixar `qty` (milésimos)? Sem saldo, o garçom não fica travado: só não baixa. */
  const fits = (sup: Supply, qty: number) => !sup.stockTracked || panel.allowNegativeStock || sup.stockQty >= qty;
  // Carvão: o primeiro com saldo; sem nenhum, lança sem baixar carvão.
  const coal = panel.coals.find((x) => fits(x, coalWanted * 1000)) ?? null;
  const coalUnits = coal ? coalWanted : 0;
  const price = sheet.kind === 'rent' ? p.rentalCents : sheet.kind === 'own' ? p.ownRoshCents : sheet.own ? p.ownRoshCents : p.roshSwapCents;
  const charged = sheet.kind !== 'rosh' || charge;
  const title = sheet.kind === 'rent' ? 'Alugar narguilé' : sheet.kind === 'own' ? 'Narguilé do cliente' : `${sheet.own ? 'Novo rosh' : 'Troca de rosh'} · ${sheet.title}`;
  /** Porção de cada sabor, em milésimos de grama. */
  const perFlavor = flavors.length ? panel.gramsPerRosh / flavors.length : 0;

  const toggle = (e: Supply) => {
    if (flavors.includes(e.id)) return setFlavors(flavors.filter((x) => x !== e.id));
    if (flavors.length >= 3) return toast.info('No máximo 3 sabores por rosh.');
    const need = Math.ceil(panel.gramsPerRosh / (flavors.length + 1));
    const short = [e, ...panel.essences.filter((x) => flavors.includes(x.id))].find((x) => !fits(x, need));
    if (short) return toast.error(`${short.name} não tem saldo no estoque para mais ${formatQty(need, 'mass')}.`);
    setFlavors([...flavors, e.id]);
  };

  const submit = async () => {
    setBusy(true);
    const consumption = { essences: essencesPayload(flavors, panel.gramsPerRosh), coalProductId: coal?.id ?? null, coalUnits };
    try {
      if (sheet.kind === 'rosh') {
        await api.post(`/api/hookah-sessions/${sheet.sessionId}/rosh`, { ...consumption, charge, clientRequestId: rid });
      } else {
        await api.post('/api/hookah-sessions', {
          mode: sheet.kind === 'own' ? 'own' : 'house', hookahId: sheet.kind === 'rent' ? device : null, ownLabel: sheet.kind === 'own' && label.trim() ? label.trim() : null,
          comandaId, clientRequestId: rid, ...consumption,
        });
      }
      toast.success(charged ? `${formatBRL(price)} lançado na comanda` : 'Troca cortesia registrada');
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mhookah stack pop-in">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="num strong" style={{ fontSize: 20 }}>{charged ? formatBRL(price) : 'Cortesia'}</span>
      </div>
      {sheet.kind === 'rent' && <div className="banner small">Essência e carvão já estão no valor do aluguel. A troca de rosh custa {formatBRL(p.roshSwapCents)}.</div>}

      <div className="stack-s">
        <div className="section-label">Sabor{flavors.length > 1 ? 'es (mistura)' : ''}</div>
        {panel.essences.length === 0 ? (
          <p className="small muted">Nenhuma essência no estoque. O valor é lançado do mesmo jeito.</p>
        ) : (
          <div className="mhookah-flavors" role="group" aria-label="Sabores">
            {panel.essences.map((e) => {
              const on = flavors.includes(e.id);
              const empty = !fits(e, Math.ceil(panel.gramsPerRosh / 3));
              return (
                <button key={e.id} type="button" className={`chip mhookah-flavor ${on ? 'active' : ''}`} aria-pressed={on} disabled={empty && !on} onClick={() => toggle(e)}>
                  {on && <Check size={15} />}
                  <span className="ellipsis">{e.name}</span>
                  {empty && <span className="tiny danger-text">sem saldo</span>}
                </button>
              );
            })}
          </div>
        )}
        <span className="tiny muted">
          {flavors.length ? `${formatQty(panel.gramsPerRosh, 'mass')} no total${flavors.length > 1 ? ` (${formatQty(Math.round(perFlavor), 'mass')} de cada)` : ''}` : 'Toque no sabor para dar baixa no estoque (até 3 para mistura).'}
          {coal ? ` · ${coalUnits} carvões` : panel.coals.length ? ' · carvão sem saldo no estoque (não será baixado)' : ''}
        </span>
      </div>

      {sheet.kind === 'rent' && panel.devices.length > 0 && (
        <div className="stack-s">
          <div className="section-label">Qual aparelho? (opcional)</div>
          <div className="mhookah-flavors" role="radiogroup" aria-label="Aparelho">
            <button type="button" role="radio" aria-checked={device === null} className={`chip ${device === null ? 'active' : ''}`} onClick={() => setDevice(null)}>Não escolher</button>
            {panel.devices.map((d) => (
              <button key={d.id} type="button" role="radio" aria-checked={device === d.id} className={`chip ${device === d.id ? 'active' : ''}`} onClick={() => setDevice(d.id)}>{d.code}</button>
            ))}
          </div>
        </div>
      )}
      {sheet.kind === 'own' && <Input placeholder="Identificação (opcional): ex. preto do Pedro" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />}
      {sheet.kind === 'rosh' && <Switch checked={!charge} onChange={(v) => setCharge(!v)} label="Troca cortesia" description="Não cobra, só dá baixa no estoque." />}

      <div className="mhookah-footer">
        <Button size="large" onClick={onCancel}>Cancelar</Button>
        <Button variant="primary" size="large" className="grow" loading={busy} icon={<Plus size={18} />} onClick={submit}>
          {charged ? `Lançar ${formatBRL(price)}` : 'Registrar troca'}
        </Button>
      </div>
    </div>
  );
}

/** Pacote de essência fechado: item comum do cardápio, lançado como pedido. */
function PackSheet({ comandaId, packs, onCancel, onDone }: { comandaId: string; packs: MenuItem[]; onCancel: () => void; onDone: () => void }) {
  const toast = useToast();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [rid] = useState(requestId);
  const chosen = packs.filter((i) => (qty[i.presentationId] ?? 0) > 0);
  const total = chosen.reduce((a, i) => a + i.priceCents * qty[i.presentationId]!, 0);
  const add = (id: string, d: number) => setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(20, (q[id] ?? 0) + d)) }));

  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/orders?source=mobile', { comandaId, clientRequestId: rid, items: chosen.map((i) => ({ presentationId: i.presentationId, quantity: qty[i.presentationId] })) });
      toast.success(`${formatBRL(total)} lançado na comanda`);
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mhookah stack pop-in">
      <h2 style={{ margin: 0 }}>Pacote de essência fechado</h2>
      <div className="stack-s">
        {packs.map((i) => {
          const n = qty[i.presentationId] ?? 0;
          return (
            <div key={i.presentationId} className={`card tight row mhookah-pack ${n ? 'in-cart' : ''} ${i.soldOut ? 'sold-out' : ''}`}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="strong ellipsis">{i.productName}</div>
                <div className="small muted">{i.presentationName} · <span className="num">{formatBRL(i.priceCents)}</span>{i.soldOut && ' · esgotado'}</div>
              </div>
              {n > 0 && <Button size="small" onClick={() => add(i.presentationId, -1)} aria-label={`Tirar ${i.productName}`}>−</Button>}
              {n > 0 && <span className="num strong" style={{ minWidth: 20, textAlign: 'center' }}>{n}</span>}
              <Button size="small" variant={n ? 'primary' : 'default'} disabled={i.soldOut} onClick={() => add(i.presentationId, 1)} aria-label={`Adicionar ${i.productName}`}>+</Button>
            </div>
          );
        })}
      </div>
      <div className="mhookah-footer">
        <Button size="large" onClick={onCancel}>Cancelar</Button>
        <Button variant="primary" size="large" className="grow" disabled={!chosen.length} loading={busy} icon={<Plus size={18} />} onClick={submit}>
          Lançar {total > 0 && formatBRL(total)}
        </Button>
      </div>
    </div>
  );
}
