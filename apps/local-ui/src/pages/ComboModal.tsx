import { packName, unitName } from '@rupbar/core';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { OptionGroupsField } from '../components/OptionGroups';
import { Button, Card, DecimalInput, ErrorBox, Field, Input, Loading, Modal, MoneyInput, Select, useToast } from '../components/ui';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import '../styles/stock.css';
import { packagingOf, type Category, type Product } from './Products';

interface ItemDraft {
  productId: string;
  amount: number | null;
}

/** Garrafas e pacotes vão inteiros (1 garrafa = 1.000 ml); o resto por unidade. */
function wholeLabel(p: Product, n: number): string {
  return p.measure === 'unit' ? unitName(packagingOf(p), n) : packName(packagingOf(p), n);
}
function qtyMilli(p: Product, amount: number): number {
  return Math.round(p.measure === 'unit' ? amount * 1000 : amount * p.packageQty);
}

/**
 * Combo em uma tela: o preço do combo, o que vai fixo (a garrafa fechada,
 * 1 balde de gelo…) e o que o cliente escolhe na hora (5 gelos do sabor X,
 * 4 latas do energético Y). Ao vender, baixa a garrafa inteira e os
 * adicionais escolhidos.
 */
export function ComboModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const categories = useLoad(() => api.get<Category[]>('/api/categories'));
  const products = useLoad(() => api.get<Product[]>('/api/products'));
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const [items, setItems] = useState<ItemDraft[]>([{ productId: '', amount: 1 }]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [groupQty, setGroupQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const stock = (products.data ?? []).filter((p) => p.active && p.stockTracked);
  const category = categoryId || categories.data?.find((c) => c.name === 'Drinks')?.id || categories.data?.[0]?.id || '';
  const set = (i: number, patch: Partial<ItemDraft>) => setItems((x) => x.map((it, k) => (k === i ? { ...it, ...patch } : it)));

  const save = async () => {
    if (name.trim().length < 2) return toast.error('Dê um nome para o combo (ex.: Combo Gin + 4 Red Bull).');
    if (price === null || price <= 0) return toast.error('Informe o preço do combo.');
    const filled = items.filter((i) => i.productId);
    const bad = filled.find((i) => !(i.amount && i.amount > 0));
    if (bad) return toast.error('Informe a quantidade de cada item do combo.');
    if (!filled.length && !groupIds.length) return toast.error('Coloque ao menos um item ou uma escolha no combo.');
    setBusy(true);
    try {
      await api.post('/api/products', {
        name: name.trim(), categoryId: category, measure: 'unit', stockTracked: false, menuVisible: true,
        presentations: [{
          name: 'Combo', priceCents: price,
          components: filled.map((i) => ({ productId: i.productId, qty: qtyMilli(stock.find((p) => p.id === i.productId)!, i.amount!) })),
        }],
        optionGroups: groupIds.map((groupId) => ({ groupId, quantity: groupQty[groupId] ?? 1 })),
      });
      toast.success('Combo criado: já aparece no cardápio');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Novo combo" wide onClose={onClose} footer={<><Button onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Criar combo{price ? ` de ${formatBRL(price)}` : ''}</Button></>}>
      {categories.error ? <ErrorBox error={categories.error} onRetry={categories.reload} /> : !categories.data || !products.data ? <Loading /> : (
        <div className="stack quick-product">
          <Card title={<h3><span className="step-number">1</span>O combo</h3>} className="form-section">
            <div className="grid-3">
              <Field label="Nome do combo"><Input autoFocus value={name} maxLength={80} placeholder="Combo Gin Rocks + 4 energéticos" onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Categoria"><Select value={category} onChange={(e) => setCategoryId(e.target.value)}>{categories.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
              <Field label="Preço do combo" hint="Opções com preço a mais somam em cima."><MoneyInput value={price} onChange={setPrice} /></Field>
            </div>
          </Card>

          <Card title={<h3><span className="step-number">2</span>O que vai sempre no combo</h3>} className="form-section">
            <div className="stack">
              {items.map((it, i) => {
                const p = stock.find((x) => x.id === it.productId);
                return (
                  <div key={i} className="combo-item-row">
                    <Field label="Produto">
                      <Select value={it.productId} onChange={(e) => set(i, { productId: e.target.value })}>
                        <option value="">Escolha… (ex.: a garrafa)</option>
                        {stock.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Quantidade" hint={p && p.measure !== 'unit' && it.amount ? `= ${(qtyMilli(p, it.amount) / 1000).toLocaleString('pt-BR')} ${p.measure === 'volume' ? 'ml' : 'g'}` : undefined}>
                      <DecimalInput value={it.amount} onChange={(v) => set(i, { amount: v })} suffix={p ? wholeLabel(p, 2) : ''} />
                    </Field>
                    <Button variant="plain" icon={<Trash2 size={15} />} aria-label="Tirar item" disabled={items.length === 1} onClick={() => setItems((x) => x.filter((_, k) => k !== i))} />
                  </div>
                );
              })}
              <Button variant="plain" size="small" icon={<Plus size={15} />} style={{ alignSelf: 'flex-start' }} onClick={() => setItems((x) => [...x, { productId: '', amount: 1 }])}>Item</Button>
              <p className="tiny muted">Garrafas vão inteiras: 1 garrafa de 1 L baixa 1.000 ml do estoque a cada combo vendido.</p>
            </div>
          </Card>

          <Card title={<h3><span className="step-number">3</span>O que o cliente escolhe <span className="muted small">(opcional)</span></h3>} className="form-section">
            <OptionGroupsField value={groupIds} onChange={setGroupIds} qty={groupQty} onQtyChange={setGroupQty}
              example="Ex.: Sabor do gelo × 5 e Energético × 4: na hora do pedido o garçom escolhe o sabor e o energético, e o estoque baixa 5 gelos e 4 latas do que foi escolhido. Opção com preço a mais (Red Bull) soma 4 vezes." />
          </Card>
        </div>
      )}
    </Modal>
  );
}
