import { Beer, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, MoneyInput, Select, useToast } from '../components/ui';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import '../styles/stock.css';
import type { Category, Product } from './Products';

interface OptionGroupView {
  id: string;
  name: string;
  required: boolean;
  active: boolean;
  choices: { id: string; name: string; priceDeltaCents: number; productId: string | null; qty: number }[];
}

interface BeerRow {
  /** Opção já salva (edição): mantém o histórico das vendas. */
  choiceId?: string;
  productId: string;
  priceCents: number | null;
}

/**
 * Balde é um produto de preço zero com uma escolha obrigatória (a cerveja).
 * Reconhece o balde para abrir esta tela em vez do cadastro completo.
 */
export function isBucket(p: Product): boolean {
  const active = p.presentations.filter((x) => x.active);
  return !p.stockTracked && active.length === 1 && active[0]!.priceCents === 0 && (p.optionGroups ?? []).length === 1;
}

/**
 * Balde de cerveja: no pedido escolhe o balde e, em seguida, a cerveja. Cada
 * cerveja tem o preço do balde dela, e o estoque baixa as N unidades da
 * cerveja escolhida.
 */
export function BucketModal({ product, onClose, onSaved }: { product?: Product; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const categories = useLoad(() => api.get<Category[]>('/api/categories'));
  const products = useLoad(() => api.get<Product[]>('/api/products'));
  const groups = useLoad(() => api.get<OptionGroupView[]>('/api/option-groups'));
  const [name, setName] = useState(product?.name ?? 'Balde de cerveja');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [count, setCount] = useState<number | null>(5);
  const [rows, setRows] = useState<BeerRow[]>([{ productId: '', priceCents: null }]);
  const [loaded, setLoaded] = useState(!product);
  const [busy, setBusy] = useState(false);

  const group = product && groups.data?.find((g) => g.id === product.optionGroups?.[0]?.groupId);
  // Edição: preenche com as cervejas e os preços já cadastrados.
  useEffect(() => {
    if (loaded || !group) return;
    const choices = group.choices.filter((c) => c.productId);
    if (choices.length) {
      setCount(Math.max(1, Math.round(choices[0]!.qty / 1000)));
      setRows(choices.map((c) => ({ choiceId: c.id, productId: c.productId!, priceCents: c.priceDeltaCents })));
    }
    setLoaded(true);
  }, [group, loaded]);

  // Cervejas e o que mais se vende por unidade (long neck, lata, garrafa).
  const beers = (products.data ?? []).filter((p) => p.active && p.measure === 'unit' && !isBucket(p) && p.id !== product?.id);
  const category = categoryId || categories.data?.find((c) => /cerveja/i.test(c.name))?.id || categories.data?.[0]?.id || '';
  const set = (i: number, patch: Partial<BeerRow>) => setRows((x) => x.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.productId);
  const prices = filled.map((r) => r.priceCents ?? 0).filter((v) => v > 0);

  const save = async () => {
    if (name.trim().length < 2) return toast.error('Dê um nome para o balde (ex.: Balde de cerveja).');
    if (!count || count < 1 || count > 50) return toast.error('Informe quantas cervejas vão no balde.');
    if (!filled.length) return toast.error('Escolha ao menos uma cerveja.');
    const noPrice = filled.find((r) => !r.priceCents);
    if (noPrice) return toast.error(`Informe o preço do balde de ${beers.find((b) => b.id === noPrice.productId)?.name ?? 'cada cerveja'}.`);
    if (new Set(filled.map((r) => r.productId)).size !== filled.length) return toast.error('Cada cerveja entra uma vez só.');
    setBusy(true);
    try {
      const choices = filled.map((r) => ({
        id: r.choiceId, name: (beers.find((b) => b.id === r.productId)?.name ?? 'Cerveja').slice(0, 40),
        priceDeltaCents: r.priceCents!, productId: r.productId, qty: count * 1000, active: true,
      }));
      if (product && group) {
        await api.put(`/api/option-groups/${group.id}`, { name: group.name, required: true, active: true, choices });
        toast.success(`${product.name} atualizado`);
      } else {
        const taken = new Set((groups.data ?? []).map((g) => g.name.toLocaleLowerCase('pt-BR')));
        const groupName = (taken.has('cerveja do balde') ? `Cerveja (${name.trim()})` : 'Cerveja do balde').slice(0, 40);
        const g = await api.post<{ id: string }>('/api/option-groups', { name: groupName, required: true, active: true, choices });
        await api.post('/api/products', {
          name: name.trim(), categoryId: category, measure: 'unit', stockTracked: false, menuVisible: true,
          presentations: [{ name: 'Balde', priceCents: 0, components: [] }],
          optionGroups: [{ groupId: g.id, quantity: 1 }],
        });
        toast.success('Balde criado: já aparece no cardápio');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const ready = categories.data && products.data && groups.data && loaded;
  return (
    <Modal title={product ? `Editar ${product.name}` : 'Novo balde'} wide onClose={onClose}
      footer={<><Button onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="primary" icon={<Beer size={16} />} loading={busy} onClick={() => void save()}>{product ? 'Salvar balde' : 'Criar balde'}</Button></>}>
      {categories.error || products.error || groups.error ? (
        <ErrorBox error={categories.error ?? products.error ?? groups.error} onRetry={() => { void categories.reload(); void products.reload(); void groups.reload(); }} />
      ) : !ready ? <Loading /> : (
        <div className="stack quick-product">
          <p className="small muted">
            No pedido: toque em <strong>{name.trim() || 'Balde'}</strong> e escolha a cerveja. Cobra o preço do balde daquela cerveja e baixa {count || 'N'} unidade{count === 1 ? '' : 's'} dela do estoque.
          </p>
          <Card title={<h3><span className="step-number">1</span>O balde</h3>} className="form-section">
            <div className="grid-3">
              <Field label="Nome"><Input autoFocus={!product} value={name} maxLength={80} disabled={!!product} placeholder="Balde de cerveja" onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Categoria"><Select value={category} disabled={!!product} onChange={(e) => setCategoryId(e.target.value)}>{categories.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
              <Field label="Cervejas no balde" hint="Quantas unidades saem do estoque.">
                <Input inputMode="numeric" value={count ?? ''} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 2); setCount(v ? Number(v) : null); }} />
              </Field>
            </div>
          </Card>

          <Card title={<h3><span className="step-number">2</span>As cervejas e o preço do balde de cada uma</h3>} className="form-section">
            <div className="stack">
              {rows.map((r, i) => (
                <div key={i} className="combo-item-row">
                  <Field label="Cerveja">
                    <Select value={r.productId} aria-label={`Cerveja ${i + 1}`} onChange={(e) => set(i, { productId: e.target.value })}>
                      <option value="">Escolha… (ex.: Heineken long neck)</option>
                      {beers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Preço do balde"><MoneyInput value={r.priceCents} onChange={(v) => set(i, { priceCents: v })} /></Field>
                  <Button variant="plain" icon={<Trash2 size={15} />} aria-label="Tirar cerveja" disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((_, k) => k !== i))} />
                </div>
              ))}
              <Button variant="plain" size="small" icon={<Plus size={15} />} style={{ alignSelf: 'flex-start' }} onClick={() => setRows((x) => [...x, { productId: '', priceCents: null }])}>Cerveja</Button>
              {prices.length > 0 && <p className="tiny muted">No cardápio aparece "a partir de {formatBRL(Math.min(...prices))}".</p>}
            </div>
          </Card>
        </div>
      )}
    </Modal>
  );
}
