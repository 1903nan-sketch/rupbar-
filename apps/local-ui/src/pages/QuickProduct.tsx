import { BASE_UNIT, formatQty, type Measure } from '@rupbar/core';
import { Boxes, Package, Wine } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, DecimalInput, ErrorBox, Field, Input, Loading, Modal, MoneyInput, Select, Switch, useToast } from '../components/ui';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Category } from './Products';

type Kind = 'unit' | 'volume' | 'mass';
const KINDS: { value: Kind; title: string; hint: string; icon: typeof Package; size: number; label: string }[] = [
  { value: 'unit', title: 'Por unidade', hint: 'Latas, garrafas e itens avulsos', icon: Package, size: 1, label: 'unidade' },
  { value: 'volume', title: 'Garrafa e doses', hint: 'Bebidas vendidas por ml', icon: Wine, size: 1000, label: 'garrafa' },
  { value: 'mass', title: 'Ingrediente', hint: 'Insumos controlados por grama', icon: Boxes, size: 50, label: 'pacote' },
];

/** Cadastro e primeira entrada juntos, sem navegar por três abas. */
export function QuickProductModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const { can } = useSession();
  const categories = useLoad(() => api.get<Category[]>('/api/categories'));
  const [kind, setKind] = useState<Kind>('unit');
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [size, setSize] = useState<number | null>(1);
  const [label, setLabel] = useState('unidade');
  const [sell, setSell] = useState(true);
  const [price, setPrice] = useState<number | null>(null);
  const [dose, setDose] = useState<number | null>(50);
  const [packages, setPackages] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [min, setMin] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const unit = BASE_UNIT[kind as Measure];
  const selectedCategory = categoryId || categories.data?.[0]?.id || '';
  const initialQty = Math.round((packages ?? 0) * (size ?? 0) * 1000);
  const totalCost = Math.round((packages ?? 0) * (cost ?? 0));

  const submit = async () => {
    if (busy) return;
    if (name.trim().length < 2 || !selectedCategory) return toast.error('Informe o nome e a categoria do produto.');
    if (!size || size <= 0 || Math.round(size * 1000) <= 0) return toast.error('Informe um conteúdo de embalagem maior que zero.');
    if (sell && (price === null || price < 0)) return toast.error('Informe o preço de venda.');
    if (sell && kind === 'volume' && (!dose || dose <= 0 || Math.round(dose * 1000) <= 0)) return toast.error('Informe o tamanho da dose.');
    if (min !== null && min < 0) return toast.error('O estoque mínimo não pode ser negativo.');
    if (packages !== null && (packages < 0 || packages > 100_000 || (packages > 0 && initialQty === 0))) return toast.error('Confira a quantidade de embalagens do saldo inicial.');
    if ((packages ?? 0) > 0 && (cost === null || cost < 0)) return toast.error('Informe o custo de compra por embalagem. Use zero somente se não houve custo.');
    setBusy(true);
    try {
      const result = await api.post<{ id: string }>('/api/products', {
        name: name.trim(), categoryId: selectedCategory, measure: kind, packageQty: Math.round(size * 1000), packageLabel: label.trim() || null,
        stockTracked: true, minStock: Math.round((min ?? 0) * 1000), menuVisible: sell,
        presentations: sell ? [{ name: kind === 'volume' ? `Dose ${dose} ml` : 'Unidade', priceCents: price,
          components: [{ productId: null, qty: Math.round((kind === 'volume' ? dose! : kind === 'mass' ? size : 1) * 1000) }] }] : [],
        initialStock: can('stock.entry') && (packages ?? 0) > 0 ? { packages, totalCostCents: totalCost } : undefined,
      });
      toast.success((packages ?? 0) > 0 ? 'Produto e saldo inicial cadastrados' : 'Produto cadastrado');
      onSaved(result.id);
      onClose();
    } catch (error) { toast.error(error); }
    finally { setBusy(false); }
  };

  return <Modal title="Novo produto" wide onClose={onClose} footer={<><Button onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!categories.data?.length} onClick={submit}>Cadastrar produto</Button></>}>
    {categories.error ? <ErrorBox error={categories.error} onRetry={categories.reload} /> : !categories.data ? <Loading /> : <div className="stack">
      <p className="muted small">Cadastre o produto e o estoque em uma única etapa. Depois, abra o produto para adicionar fotos, fornecedores ou outras apresentações.</p>
      <div className="product-kind-options" role="group" aria-label="Tipo de produto">{KINDS.map((option) => {
        const Icon = option.icon;
        return <button key={option.value} type="button" className={`product-kind ${kind === option.value ? 'active' : ''}`} aria-pressed={kind === option.value} onClick={() => {
          setKind(option.value); setSize(option.size); setLabel(option.label); setSell(option.value !== 'mass');
        }}><Icon size={22} /><strong>{option.title}</strong><span>{option.hint}</span></button>;
      })}</div>
      <div className="grid-2">
        <Card title="1. Identifique o produto" className="form-section">
          <div className="stack">
            <Field label="Nome do produto"><Input autoFocus placeholder="Ex.: Coca-Cola 600 ml" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Categoria"><Select value={selectedCategory} onChange={(e) => setCategoryId(e.target.value)}>{categories.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <div className="grid-2">
              <Field label={`Conteúdo da embalagem (${unit})`} hint={kind === 'unit' ? '1 para uma lata; 12 para uma caixa com 12 unidades.' : kind === 'volume' ? 'Garrafa de 1 L = 1000 ml.' : 'Pacote de 50 g = 50.'}><DecimalInput value={size} onChange={setSize} suffix={unit} /></Field>
              <Field label="Nome da embalagem"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="lata, caixa, garrafa…" /></Field>
            </div>
            <Switch label="Vender no cardápio" description="Desative para ingredientes e insumos." checked={sell} onChange={setSell} />
            {sell && <div className={kind === 'volume' ? 'grid-2' : ''}>
              {kind === 'volume' && <Field label="Tamanho da dose (ml)"><DecimalInput value={dose} onChange={setDose} suffix="ml" /></Field>}
              <Field label={kind === 'volume' ? 'Preço da dose' : kind === 'mass' ? 'Preço da embalagem' : 'Preço por unidade'}><MoneyInput value={price} onChange={setPrice} /></Field>
            </div>}
          </div>
        </Card>
        <Card title="2. Informe o estoque" className="form-section">
          <div className="stack">
            {can('stock.entry') && <>
              <Field label="Embalagens em estoque" hint="Opcional. Deixe em branco para cadastrar sem saldo."><DecimalInput value={packages} onChange={setPackages} placeholder="Ex.: 24" /></Field>
              <Field label="Custo de compra por embalagem" hint="O custo de compra é diferente do preço de venda."><MoneyInput value={cost} onChange={setCost} /></Field>
            </>}
            <Field label={`Estoque mínimo (${unit})`} hint="Opcional. Avisa quando o saldo chegar a este nível."><DecimalInput value={min} onChange={setMin} suffix={unit} /></Field>
            <div className="stock-entry-summary">
              <span className="label">Saldo inicial</span><strong>{formatQty(initialQty, kind)}</strong>
              {(packages ?? 0) > 0 && <span className="small muted">{packages} × {size} {unit} · custo total {cost === null ? 'a informar' : formatBRL(totalCost)}</span>}
            </div>
            <p className="tiny muted">O saldo inicial gera uma entrada no histórico. As vendas baixam o estoque automaticamente.</p>
          </div>
        </Card>
      </div>
    </div>}
  </Modal>;
}
