import { Check } from 'lucide-react';
import { useState } from 'react';
import type { Menu } from '../components/MenuPicker';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, Select, useToast } from '../components/ui';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import '../styles/stock.css';
import type { Category } from './Products';

/**
 * As porções que podem ser metade, escolhidas entre os itens à venda.
 * Cada metade baixa metade da ficha técnica da porção escolhida.
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

/** Meio a meio em uma tela: nome, categoria e de quais porções ele puxa. */
export function HalfHalfModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const categories = useLoad(() => api.get<Category[]>('/api/categories'));
  const [name, setName] = useState('Porção meio a meio');
  const [categoryId, setCategoryId] = useState('');
  const [parts, setParts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const category = categoryId || categories.data?.find((c) => c.name === 'Porções')?.id || categories.data?.[0]?.id || '';

  const save = async () => {
    if (name.trim().length < 2) return toast.error('Dê um nome (ex.: Porção meio a meio).');
    if (parts.length < 2) return toast.error('Escolha ao menos duas porções que podem ser metade.');
    setBusy(true);
    try {
      await api.post('/api/products', {
        name: name.trim(), categoryId: category, measure: 'unit', stockTracked: false, menuVisible: true,
        presentations: [{ name: name.trim(), priceCents: 0, halves: parts }],
      });
      toast.success('Meio a meio criado: já aparece no cardápio');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Novo meio a meio" wide onClose={onClose} footer={<><Button onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Criar meio a meio</Button></>}>
      {categories.error ? <ErrorBox error={categories.error} onRetry={categories.reload} /> : !categories.data ? <Loading /> : (
        <div className="stack quick-product">
          <Card title={<h3><span className="step-number">1</span>O meio a meio</h3>} className="form-section">
            <div className="grid-2">
              <Field label="Nome"><Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Categoria"><Select value={category} onChange={(e) => setCategoryId(e.target.value)}>{categories.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            </div>
          </Card>
          <Card title={<h3><span className="step-number">2</span>De quais porções ele puxa</h3>} className="form-section">
            <div className="stack">
              <p className="small muted">No pedido o garçom escolhe a 1ª e a 2ª metade entre estas. Cobra o preço da porção mais cara e baixa do estoque metade de cada uma (ex.: meia batata e meia polenta).</p>
              <HalfPartsField value={parts} onChange={setParts} />
            </div>
          </Card>
        </div>
      )}
    </Modal>
  );
}
