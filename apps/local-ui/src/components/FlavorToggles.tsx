import { Leaf, Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { formatQty } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { Empty, ErrorBox, Input, Loading, useToast } from './ui';

export interface FlavorOption {
  productId: string;
  productName: string;
  category: string;
  stockQty: number;
  stockTracked: boolean;
  /** Está na lista do aluguel. */
  on: boolean;
  /** Nome do sabor no aluguel (padrão: a essência sem o tamanho do pacote). */
  name: string;
}

/**
 * Lista das essências de venda com um botão "no aluguel" em cada uma: tocar
 * põe ou tira o sabor do aluguel na hora. O rosh baixa os gramas do mesmo
 * pacote vendido no cardápio. No PC, quem gerencia também renomeia o sabor.
 */
export function FlavorToggles({ renamable }: { renamable?: boolean }) {
  const toast = useToast();
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api.get<FlavorOption[]>('/api/hookah/flavor-options'));
  useRealtime('hookah', () => void reload());
  const [list, setList] = useState<FlavorOption[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const items = list ?? data;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!items) return <Loading />;
  const canToggle = can('hookah.rent') || can('hookah.manage');
  const canRename = !!renamable && can('hookah.manage');
  const term = q.trim().toLocaleLowerCase('pt-BR');
  const shown = term ? items.filter((o) => `${o.name} ${o.productName}`.toLocaleLowerCase('pt-BR').includes(term)) : items;
  const onCount = items.filter((o) => o.on).length;

  const toggle = async (o: FlavorOption, on: boolean) => {
    setBusy(o.productId);
    try {
      setList(await api.post<FlavorOption[]>('/api/hookah/flavors/toggle', { productId: o.productId, on }));
      toast.success(on ? `${o.name} no aluguel` : `${o.name} fora do aluguel`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const rename = async (o: FlavorOption, name: string) => {
    const clean = name.trim();
    if (!clean || clean === o.name) return;
    const next = items.map((x) => (x.productId === o.productId ? { ...x, name: clean } : x));
    try {
      await api.put('/api/hookah/flavors', { flavors: next.filter((x) => x.on).map((x) => ({ productId: x.productId, name: x.name })) });
      setList(next);
      toast.success('Nome do sabor salvo');
    } catch (e) {
      toast.error(e);
    }
  };

  if (!items.length) {
    return (
      <Empty icon={<Leaf size={36} />} title="Nenhuma essência cadastrada">
        Cadastre as essências para venda (Estoque → Novo produto → Pacote de X g, categoria Essências). Depois é só ligar aqui as que vão para o aluguel.
      </Empty>
    );
  }
  return (
    <div className="stack flavor-toggles">
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="small muted">{onCount} de {items.length} no aluguel</span>
        {items.length > 6 && (
          <div className="input-group" style={{ maxWidth: 260 }}>
            <Search size={15} className="prefix" />
            <Input placeholder="Buscar sabor" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar sabor" />
          </div>
        )}
      </div>
      <div className="flavor-list">
        {shown.map((o) => (
          <div key={o.productId} className={`flavor-item ${o.on ? 'on' : ''}`}>
            <div className="grow" style={{ minWidth: 0 }}>
              {canRename && o.on ? (
                <Input defaultValue={o.name} maxLength={60} aria-label={`Nome do sabor ${o.productName}`} onBlur={(e) => void rename(o, e.target.value)} />
              ) : <strong className="ellipsis" style={{ display: 'block' }}>{o.name}</strong>}
              <span className="tiny muted">{o.productName}{o.stockTracked ? ` · ${formatQty(o.stockQty, 'mass')}` : ''}</span>
            </div>
            <label className="switch" title={o.on ? 'No aluguel' : 'Fora do aluguel'}>
              <input type="checkbox" aria-label={`No aluguel: ${o.name}`} checked={o.on} disabled={!canToggle || busy === o.productId} onChange={(e) => void toggle(o, e.target.checked)} />
              <span />
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
