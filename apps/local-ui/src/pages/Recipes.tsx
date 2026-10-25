import { bigUnitName, costOf, formatQty, KILO, MILLI, type Measure } from '@rupbar/core';
import { CookingPot, PackagePlus, Plus, ScrollText, Trash2, TriangleAlert, Carrot } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { LevelChip } from '../components/stock-units';
import { Button, Card, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, useToast } from '../components/ui';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import '../styles/stock.css';
import type { Category, Product } from './Products';
import { QuickProductModal } from './QuickProduct';
import { PurchaseModal } from './Stock';

type Presentation = Product['presentations'][number];
/** Um prato do cardápio com ficha técnica (uma apresentação que consome insumos). */
interface Dish { product: Product; pres: Presentation; label: string }

const plain = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const rowDelay = (i: number) => ({ '--i': Math.min(i, 14) }) as CSSProperties;
const dishLabel = (product: Product, pres: Presentation) => (plain(pres.name) === plain(product.name) ? product.name : `${product.name} — ${pres.name}`);
const usesIngredients = (pres: Presentation) => pres.components.some((c) => !c.isSelf);

/** "R$ 12,00/kg", "R$ 0,80/un" a partir do custo médio das entradas. */
function costPerText(p: Product): string | null {
  if (!p.unitCostE4) return null;
  const big = bigUnitName(p.measure);
  return `${formatBRL(costOf(big ? KILO : MILLI, p.unitCostE4))}/${big ?? 'un'}`;
}

function marginPct(price: number, cost: number | null | undefined): number | null {
  return cost === null || cost === undefined || price <= 0 ? null : Math.round(((price - cost) / price) * 100);
}

/**
 * Fichas técnicas: insumos com estoque (batata, queijo, bacon) e os pratos que os
 * consomem. Cada venda baixa de cada insumo a quantidade da ficha × quantidade vendida.
 */
export function RecipesPage() {
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api.get<Product[]>('/api/products'));
  const categories = useLoad(() => api.get<Category[]>('/api/categories'));
  useRealtime(['stock'], () => void reload());
  const [newIngredient, setNewIngredient] = useState(false);
  const [entry, setEntry] = useState<Product | 'new' | null>(null);
  const [editing, setEditing] = useState<Dish | 'new' | null>(null);

  const { dishes, ingredients, usedIn } = useMemo(() => {
    const all = data ?? [];
    const dishes: Dish[] = [];
    const usedIn = new Map<string, string[]>();
    for (const product of all) {
      if (!product.active) continue;
      for (const pres of product.presentations) {
        if (!pres.active || !usesIngredients(pres)) continue;
        const label = dishLabel(product, pres);
        dishes.push({ product, pres, label });
        for (const c of pres.components) usedIn.set(c.productId, [...(usedIn.get(c.productId) ?? []), label]);
      }
    }
    // Insumo: tem estoque e entra em alguma ficha, ou não é vendido sozinho (fora do cardápio).
    const ingredients = all.filter((p) => p.active && p.stockTracked && (usedIn.has(p.id) || !p.menuVisible || !p.presentations.some((x) => x.active)));
    dishes.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
    return { dishes, ingredients, usedIn };
  }, [data]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const low = ingredients.filter((p) => p.level !== 'ok');
  const byId = new Map(data.map((p) => [p.id, p]));

  return (
    <div className="stack recipes-page">
      <PageHeader title="Fichas técnicas"
        subtitle="Cadastre os insumos (batata, queijo, bacon) com o estoque em kg, g, L, ml ou unidades e diga quanto cada prato usa. Cada venda baixa os insumos sozinha: 5 kg de batata − porção de 200 g − porção de 300 g."
        actions={<>
          {can('stock.entry') && <Button icon={<PackagePlus size={16} />} onClick={() => setEntry('new')}>Entrada de insumo</Button>}
          {can('products.manage') && <Button icon={<Carrot size={16} />} onClick={() => setNewIngredient(true)}>Novo insumo</Button>}
          {can('products.manage') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')} disabled={!ingredients.length && !data.some((p) => p.stockTracked)}>Nova ficha técnica</Button>}
        </>} />

      {low.length > 0 && (
        <div className="banner warning recipes-low" role="status">
          <TriangleAlert size={18} aria-hidden="true" />
          <span className="grow">
            <strong>{low.length === 1 ? '1 insumo abaixo do mínimo' : `${low.length} insumos abaixo do mínimo`}:</strong>{' '}
            {low.map((p) => `${p.name} (${p.level === 'low' ? formatQty(p.stockQty, p.measure) : p.level === 'negative' ? 'negativo' : 'zerado'})`).join(', ')}.
          </span>
          {can('stock.entry') && <Button size="small" icon={<PackagePlus size={14} />} onClick={() => setEntry(low.length === 1 ? low[0]! : 'new')}>Dar entrada</Button>}
        </div>
      )}

      <Card flush title={<h2 className="card-heading"><CookingPot size={18} aria-hidden="true" /> Pratos com ficha técnica <span className="muted small">({dishes.length})</span></h2>}>
        {dishes.length === 0 ? (
          <Empty icon={<ScrollText size={32} />} title="Nenhum prato com ficha técnica">
            <div className="stack stock-empty-actions">
              <span>Ex.: “Porção de batata” usa 200 g de batata; “Batata com cheddar” usa 300 g de batata e 50 g de cheddar. Os dois baixam do mesmo estoque de batata.</span>
              {can('products.manage') && <Button variant="primary" onClick={() => (ingredients.length ? setEditing('new') : setNewIngredient(true))}>{ingredients.length ? 'Montar a primeira ficha' : 'Cadastrar o primeiro insumo'}</Button>}
            </div>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table stock-table recipes-table">
              <thead><tr><th>Prato</th><th>Ficha técnica (por unidade)</th><th className="right">Custo</th><th className="right">Preço</th><th className="right">Margem</th><th className="right">Dá para fazer</th></tr></thead>
              <tbody>
                {dishes.map((d, i) => {
                  const short = d.pres.components.filter((c) => byId.get(c.productId)?.level && byId.get(c.productId)!.stockTracked && byId.get(c.productId)!.level !== 'ok');
                  const margin = marginPct(d.pres.priceCents, d.pres.costCents);
                  return (
                    <tr key={d.pres.id} className={`stock-row ${can('products.manage') ? 'clickable' : ''} ${d.pres.available === 0 ? 'level-out' : short.length ? 'level-low' : ''}`} style={rowDelay(i)}
                      onClick={() => can('products.manage') && setEditing(d)}>
                      <td data-label="Produto">
                        <div className="strong">{d.label}</div>
                        <div className="tiny muted">{d.product.categoryName}{d.product.stockTracked ? ' · também tem estoque próprio' : ''}</div>
                      </td>
                      <td data-label="Ficha" className="small">
                        {d.pres.components.map((c) => `${c.isSelf ? d.product.name : c.productName} ${formatQty(c.qty, c.measure)}`).join(' + ')}
                        {short.length > 0 && <div className="tiny warning-text">{short.map((c) => c.productName).join(', ')} {short.length === 1 ? 'está' : 'estão'} abaixo do mínimo</div>}
                      </td>
                      <td data-label="Custo" className="right num">{d.pres.costCents !== null && d.pres.costCents !== undefined ? formatBRL(d.pres.costCents) : <span className="muted small">sem custo</span>}</td>
                      <td data-label="Preço" className="right num">{formatBRL(d.pres.priceCents)}</td>
                      <td data-label="Margem" className={`right num ${margin !== null && margin < 0 ? 'danger-text' : ''}`}>{margin === null ? '—' : `${margin}%`}</td>
                      <td data-label="Dá para fazer" className={`right num ${d.pres.available === 0 ? 'danger-text strong' : ''}`}>{d.pres.available ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card flush title={<h2 className="card-heading"><Carrot size={18} aria-hidden="true" /> Insumos <span className="muted small">({ingredients.length})</span></h2>}>
        {ingredients.length === 0 ? (
          <Empty icon={<Carrot size={32} />} title="Nenhum insumo ainda">
            <div className="stack stock-empty-actions">
              <span>Insumo é o que entra nos pratos e tem estoque: batata, queijo, bacon, pão. Cadastre com o saldo em kg (5 kg = 5.000 g) e o mínimo para receber o alerta.</span>
              {can('products.manage') && <Button variant="primary" onClick={() => setNewIngredient(true)}>Cadastrar insumo</Button>}
            </div>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table stock-table recipes-table">
              <thead><tr><th>Insumo</th><th className="right">Saldo</th><th className="right">Mínimo</th><th className="right">Custo médio</th><th>Usado em</th><th>Situação</th><th><span className="sr-only">Ações</span></th></tr></thead>
              <tbody>
                {ingredients.map((p, i) => {
                  const dishesOf = usedIn.get(p.id) ?? [];
                  return (
                    <tr key={p.id} className={`stock-row level-${p.level}`} style={rowDelay(i)}>
                      <td data-label="Produto"><div className="strong">{p.name}</div><div className="tiny muted">{p.categoryName}</div></td>
                      <td data-label="Saldo" className="right num strong">{formatQty(p.stockQty, p.measure)}</td>
                      <td data-label="Mínimo" className="right small muted">{p.minStock ? formatQty(p.minStock, p.measure) : '—'}</td>
                      <td data-label="Custo" className="right small">{costPerText(p) ?? <span className="muted">—</span>}</td>
                      <td data-label="Usado em" className="small">{dishesOf.length ? dishesOf.join(', ') : <span className="muted">nenhuma ficha</span>}</td>
                      <td data-label="Situação"><LevelChip level={p.level} /></td>
                      <td className="stock-actions"><div className="row end">
                        {can('stock.entry') && <Button size="small" icon={<PackagePlus size={14} />} onClick={() => setEntry(p)}>Entrada</Button>}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {newIngredient && <QuickProductModal ingredient onClose={() => setNewIngredient(false)} onSaved={() => void reload()} />}
      {entry && <PurchaseModal initialProduct={entry === 'new' ? undefined : entry} onClose={() => setEntry(null)} onDone={() => void reload()} />}
      {editing && (
        <RecipeModal dish={editing === 'new' ? null : editing} products={data} categories={categories.data ?? []}
          onClose={() => setEditing(null)} onSaved={() => void reload()} onNewIngredient={() => { setEditing(null); setNewIngredient(true); }} />
      )}
    </div>
  );
}

type LineUnit = 'base' | 'kilo';
interface Line { productId: string; amount: number | null; unit: LineUnit }

const baseUnit = (m: Measure) => (m === 'volume' ? 'ml' : m === 'mass' ? 'g' : 'un');
const lineQty = (l: Line) => Math.round((l.amount ?? 0) * (l.unit === 'kilo' ? KILO : MILLI));

/** Monta ou ajusta a ficha de um prato: insumos, quantidade por unidade, preço, custo e margem ao vivo. */
function RecipeModal({ dish, products, categories, onClose, onSaved, onNewIngredient }: {
  dish: Dish | null; products: Product[]; categories: Category[]; onClose: () => void; onSaved: () => void; onNewIngredient: () => void;
}) {
  const toast = useToast();
  const kitchen = categories.find((c) => /porc|refeic|lanche|prato|cozinha/.test(plain(c.name)))?.id ?? categories[0]?.id ?? '';
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(kitchen);
  const [price, setPrice] = useState<number | null>(dish?.pres.priceCents ?? null);
  const [lines, setLines] = useState<Line[]>(() => dish
    ? dish.pres.components.map((c) => ({ productId: c.productId, amount: c.qty / MILLI, unit: 'base' as const }))
    : [{ productId: '', amount: null, unit: 'base' }]);
  const [busy, setBusy] = useState(false);
  // Insumos primeiro (fora do cardápio ou da categoria Insumos); depois os demais produtos com estoque.
  const tracked = products.filter((p) => p.active && p.stockTracked).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const isIngredient = (p: Product) => !p.menuVisible || /insum|ingredient/.test(plain(p.categoryName)) || !p.presentations.some((x) => x.active);
  const byId = new Map(products.map((p) => [p.id, p]));

  const rows = lines.map((l) => {
    const p = byId.get(l.productId);
    const qty = lineQty(l);
    return { l, p, qty, cost: p?.unitCostE4 && qty > 0 ? costOf(qty, p.unitCostE4) : null, makes: p && qty > 0 ? Math.max(0, Math.floor(p.stockQty / qty)) : null };
  });
  const known = rows.filter((r) => r.cost !== null);
  const cost = known.length ? known.reduce((a, r) => a + r.cost!, 0) : null;
  const makes = rows.every((r) => r.makes !== null) && rows.length ? Math.min(...rows.map((r) => r.makes!)) : null;
  const margin = price !== null ? marginPct(price, cost) : null;
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    if (busy) return;
    if (!dish && name.trim().length < 2) return toast.error('Dê um nome para o prato (ex.: Porção de batata).');
    if (!dish && !categoryId) return toast.error('Escolha a categoria do prato.');
    if (price === null || price < 0) return toast.error('Informe o preço de venda do prato.');
    if (!rows.length || rows.some((r) => !r.p || r.qty <= 0)) return toast.error('Escolha o insumo e a quantidade de cada linha da ficha.');
    const components = rows.map((r) => ({ productId: r.p!.id, qty: r.qty }));
    setBusy(true);
    try {
      if (dish) {
        await api.put(`/api/presentations/${dish.pres.id}/recipe`, { priceCents: price, components });
        toast.success(`Ficha de ${dish.label} salva`);
      } else {
        // Prato sem estoque próprio: quem baixa são os insumos da ficha.
        await api.post('/api/products', {
          name: name.trim(), categoryId, measure: 'unit', packageQty: MILLI, stockTracked: false, minStock: 0, menuVisible: true, active: true,
          presentations: [{ name: name.trim(), priceCents: price, components }],
        });
        toast.success(`${name.trim()} cadastrado no cardápio com a ficha técnica`);
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={dish ? `Ficha técnica — ${dish.label}` : 'Nova ficha técnica'} wide onClose={onClose}
      footer={<>
        <span className="grow small recipe-summary">
          Custo <strong>{cost === null ? '—' : formatBRL(cost)}</strong>
          {margin !== null && <> · margem <strong className={margin < 0 ? 'danger-text' : ''}>{margin}%</strong></>}
          {makes !== null && <> · dá para fazer <strong>{makes}</strong></>}
        </span>
        <Button onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="primary" loading={busy} onClick={save}>{dish ? 'Salvar ficha' : 'Cadastrar prato'}</Button>
      </>}>
      <div className="stack">
        {!dish && (
          <div className="grid-2">
            <Field label="Nome do prato"><Input autoFocus placeholder="Ex.: Porção de batata" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Categoria" hint="Define se sai na cozinha ou no balcão."><Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          </div>
        )}
        <div className="grid-2">
          <Field label="Preço de venda"><MoneyInput value={price} onChange={setPrice} /></Field>
          {dish?.product.stockTracked && <p className="small muted" style={{ alignSelf: 'end' }}>Este produto também tem estoque próprio: a ficha substitui o que ele baixa.</p>}
        </div>
        <div className="section-label">Insumos usados em 1 unidade do prato</div>
        {rows.map(({ l, p, cost: lineCost }, i) => {
          const big = p ? bigUnitName(p.measure) : null;
          return (
            <div key={i} className="recipe-line">
              <Select aria-label={`Insumo ${i + 1}`} value={l.productId} className="grow" onChange={(e) => setLine(i, { productId: e.target.value, unit: 'base' })}>
                <option value="">Escolha o insumo…</option>
                <optgroup label="Insumos">{tracked.filter(isIngredient).map((x) => <option key={x.id} value={x.id}>{x.name} ({formatQty(x.stockQty, x.measure)})</option>)}</optgroup>
                <optgroup label="Outros produtos com estoque">{tracked.filter((x) => !isIngredient(x)).map((x) => <option key={x.id} value={x.id}>{x.name} ({formatQty(x.stockQty, x.measure)})</option>)}</optgroup>
              </Select>
              <div className="recipe-qty"><DecimalInput value={l.amount} onChange={(amount) => setLine(i, { amount })} placeholder="0" /></div>
              {p && big
                ? <Select aria-label={`Unidade do insumo ${i + 1}`} value={l.unit} className="recipe-unit" onChange={(e) => setLine(i, { unit: e.target.value as LineUnit })}>
                    <option value="base">{baseUnit(p.measure)}</option><option value="kilo">{big}</option>
                  </Select>
                : <span className="recipe-unit muted small">{p ? baseUnit(p.measure) : ''}</span>}
              <span className="recipe-line-cost small muted num">{lineCost !== null ? formatBRL(lineCost) : ''}</span>
              <Button variant="plain" icon={<Trash2 size={15} />} aria-label={`Remover insumo ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        <div className="row wrap">
          <Button variant="plain" icon={<Plus size={15} />} onClick={() => setLines([...lines, { productId: '', amount: null, unit: 'base' }])}>Adicionar insumo</Button>
          <Button variant="plain" icon={<Carrot size={15} />} onClick={onNewIngredient}>Insumo não está na lista? Cadastrar</Button>
        </div>
        <p className="tiny muted">Cada venda de 1 {dish ? dish.label : 'prato'} baixa estas quantidades do estoque dos insumos, junto com o pedido. Cancelar o item devolve. Custo = quantidade × custo médio das entradas de cada insumo.</p>
      </div>
    </Modal>
  );
}
