import { Check } from 'lucide-react';
import type { Menu } from '../components/MenuPicker';
import { ErrorBox, Loading } from '../components/ui';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import '../styles/stock.css';

/**
 * Item "meio a meio" cadastrado: as porções que podem ser metade. (O meio a
 * meio do dia a dia é escolhido na hora do pedido, sem cadastro.)
 */
export function HalfPartsField({ value, onChange, exclude }: { value: string[]; onChange: (ids: string[]) => void; exclude?: string }) {
  const menu = useLoad(() => api.get<Menu>('/api/menu'));
  if (menu.error) return <ErrorBox error={menu.error} onRetry={menu.reload} />;
  if (!menu.data) return <Loading />;
  const cats = new Map(menu.data.categories.map((c) => [c.id, c.name]));
  const items = menu.data.items.filter((i) => !i.halfParts?.length && i.presentationId !== exclude);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="half-parts" role="group" aria-label="Porções do meio a meio">
      {items.map((i) => {
        const on = value.includes(i.presentationId);
        const label = i.presentationName && i.presentationName !== i.productName && i.presentationName !== 'Unidade' ? `${i.productName} · ${i.presentationName}` : i.productName;
        return (
          <button key={i.presentationId} type="button" aria-pressed={on} className={`half-part ${on ? 'active' : ''}`} onClick={() => toggle(i.presentationId)}>
            <span className="half-part-check">{on && <Check size={14} />}</span>
            <span className="half-part-name">{label}<span className="tiny muted">{cats.get(i.categoryId)}</span></span>
            <span className="num small">{formatBRL(i.priceCents)}</span>
          </button>
        );
      })}
      {!items.length && <p className="small muted">Cadastre as porções inteiras (com preço e ficha técnica) primeiro.</p>}
    </div>
  );
}
