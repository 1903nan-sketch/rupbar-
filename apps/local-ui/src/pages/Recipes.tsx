import { bigUnitName, costOf, formatQty, KILO, MILLI, type Measure } from '@rupbar/core';
import { CookingPot, PackagePlus, Plus, ScrollText, Trash2, TriangleAlert, Carrot } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { OptionGroupsField, type OptionGroupView } from '../components/OptionGroups';
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
/** Escolha que o garçom faz no pedido (Bebida, Sabor), com quantas vão. */
interface GroupLink { group: OptionGroupView; quantity: number }
/** Um prato do cardápio com ficha técnica (insumos fixos e/ou escolhas que baixam estoque). */
interface Dish { product: Product; pres: Presentation; label: string; links: GroupLink[] }

const plain = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const rowDelay = (i: number) => ({ '--i': Math.min(i, 14) }) as CSSProperties;
const dishLabel = (product: Product, pres: Presentation) => (plain(pres.name) === plain(product.name) ? product.name : `${product.name} — ${pres.name}`);
const usesIngredients = (pres: Presentation) => pres.components.some((c) => !c.isSelf);
const withStock = (g: OptionGroupView) => g.choices.some((c) => c.productId);

/** Escolhas da apresentação e, depois, as do produto (a mesma conta uma vez), como no pedido. */
function linksOf(links: { groupId: string; quantity: number }[], groups: Map<string, OptionGroupView>): GroupLink[] {
  const seen = new Set<string>();
  return links
    .filter((l) => !seen.has(l.groupId) && seen.add(l.groupId))
    .map((l) => ({ group: groups.get(l.groupId)!, quantity: l.quantity }))
    .filter((l) => l.group?.active);
}

interface Economics { cost: [number, number] | null; price: [number, number]; margin: [number, number] | null; makes: number | null }

/**
 * Custo, preço, margem e quantos dá para fazer, somando o que sempre vai com cada
 * combinação de escolhas (caipirinha de limão com cachaça … de morango com Smirnoff).
 */
function economics(price: number, fixed: { cost: number | null; makes: number | null }, links: GroupLink[], byId: Map<string, Product>): Economics {
  const perLink = links.map(({ group, quantity }) => {
    const list = group.choices.map((c) => {
      const p = c.productId ? byId.get(c.productId) : undefined;
      const qty = c.qty * quantity;
      return {
        delta: c.priceDeltaCents * quantity,
        cost: p?.unitCostE4 ? costOf(qty, p.unitCostE4) : null,
        makes: p?.stockTracked && qty > 0 ? Math.max(0, Math.floor(p.stockQty / qty)) : Infinity,
      };
    });
    // Escolha opcional: também pode sair sem nada.
    return { required: group.required, list, options: group.required ? list : [{ delta: 0, cost: 0, makes: Infinity }, ...list] };
  }).filter((l) => l.list.length);
  const options = perLink.map((l) => l.options);
  const known = fixed.cost !== null || options.some((o) => o.some((x) => x.cost !== null && x.cost > 0));
  let combos: { delta: number; cost: number }[] = [{ delta: 0, cost: fixed.cost ?? 0 }];
  for (const o of options) {
    if (combos.length * o.length > 4096) break;
    combos = combos.flatMap((c) => o.map((x) => ({ delta: c.delta + x.delta, cost: c.cost + (x.cost ?? 0) })));
  }
  const costs = combos.map((c) => c.cost);
  const prices = combos.map((c) => price + c.delta);
  const margins = combos.map((c) => marginPct(price + c.delta, c.cost)).filter((m): m is number => m !== null);
  // Dá para fazer: o fixo e, em cada escolha obrigatória, a opção que mais rende.
  const makes = Math.min(fixed.makes ?? Infinity, ...perLink.filter((l) => l.required).map((l) => Math.max(...l.list.map((x) => x.makes))));
  return {
    cost: known ? [Math.min(...costs), Math.max(...costs)] : null,
    price: [Math.min(...prices), Math.max(...prices)],
    margin: known && margins.length ? [Math.min(...margins), Math.max(...margins)] : null,
    makes: Number.isFinite(makes) ? makes : null,
  };
}

const range = (r: [number, number], f: (n: number) => string) => (r[0] === r[1] ? f(r[0]) : `${f(r[0])} a ${f(r[1])}`);
const choicesText = (links: GroupLink[]) => links.map(({ group }) => `${group.name}: ${group.choices.map((c) => c.name).join(', ')}`).join(' · ');

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
  const optionGroups = useLoad(() => api.get<OptionGroupView[]>('/api/option-groups'));
  const reloadAll = () => { void reload(); void optionGroups.reload(); };
  useRealtime(['stock'], () => void reload());
  const [newIngredient, setNewIngredient] = useState(false);
  const [entry, setEntry] = useState<Product | 'new' | null>(null);
  const [editing, setEditing] = useState<Dish | 'new' | null>(null);

  const { dishes, ingredients, usedIn } = useMemo(() => {
    const all = data ?? [];
    const groups = new Map((optionGroups.data ?? []).map((g) => [g.id, g]));
    const dishes: Dish[] = [];
    const usedIn = new Map<string, string[]>();
    const use = (productId: string, label: string) => {
      const list = usedIn.get(productId) ?? [];
      if (!list.includes(label)) usedIn.set(productId, [...list, label]);
    };
    for (const product of all) {
      if (!product.active) continue;
      for (const pres of product.presentations) {
        if (!pres.active) continue;
        const links = linksOf([...(pres.optionGroups ?? []), ...(product.optionGroups ?? [])], groups);
        // Prato sem estoque próprio cujas escolhas baixam estoque (caipirinha: sabor e bebida) também é ficha.
        if (!usesIngredients(pres) && (product.stockTracked || !links.some((l) => withStock(l.group)))) continue;
        const label = dishLabel(product, pres);
        dishes.push({ product, pres, label, links });
        for (const c of pres.components) if (!c.isSelf) use(c.productId, label);
        for (const { group } of links) for (const c of group.choices) if (c.productId) use(c.productId, `${label} (${group.name})`);
      }
    }
    // Insumo: tem estoque e entra em alguma ficha, ou não é vendido sozinho (fora do cardápio).
    const ingredients = all.filter((p) => p.active && p.stockTracked && (usedIn.has(p.id) || !p.menuVisible || !p.presentations.some((x) => x.active)));
    dishes.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
    return { dishes, ingredients, usedIn };
  }, [data, optionGroups.data]);

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
                  const fixed = d.pres.components.filter((c) => !(c.isSelf && !d.product.stockTracked));
                  const stockIds = [...fixed.map((c) => c.productId), ...d.links.flatMap((l) => l.group.choices.map((c) => c.productId ?? ''))];
                  const short = [...new Set(stockIds)].map((id) => byId.get(id)).filter((p): p is Product => !!p && p.stockTracked && p.level !== 'ok');
                  const eco = economics(d.pres.priceCents, { cost: d.pres.costCents ?? null, makes: d.pres.available }, d.links, byId);
                  const neg = eco.margin !== null && eco.margin[0] < 0;
                  return (
                    <tr key={d.pres.id} className={`stock-row ${can('products.manage') ? 'clickable' : ''} ${eco.makes === 0 ? 'level-out' : short.length ? 'level-low' : ''}`} style={rowDelay(i)}
                      onClick={() => can('products.manage') && setEditing(d)}>
                      <td data-label="Produto">
                        <div className="strong">{d.label}</div>
                        <div className="tiny muted">{d.product.categoryName}{d.product.stockTracked ? ' · também tem estoque próprio' : ''}</div>
                      </td>
                      <td data-label="Ficha" className="small">
                        {fixed.length > 0 && <div>{fixed.map((c) => `${c.isSelf ? d.product.name : c.productName} ${formatQty(c.qty, c.measure)}`).join(' + ')}</div>}
                        {d.links.length > 0 && <div className="recipe-choices"><span className="muted">Garçom escolhe — </span>{choicesText(d.links)}</div>}
                        {short.length > 0 && <div className="tiny warning-text">{short.map((p) => p.name).join(', ')} {short.length === 1 ? 'está' : 'estão'} abaixo do mínimo</div>}
                      </td>
                      <td data-label="Custo" className="right num">{eco.cost ? range(eco.cost, formatBRL) : <span className="muted small">sem custo</span>}</td>
                      <td data-label="Preço" className="right num">{range(eco.price, formatBRL)}</td>
                      <td data-label="Margem" className={`right num ${neg ? 'danger-text' : ''}`}>{eco.margin ? range(eco.margin, (n) => `${n}%`) : '—'}</td>
                      <td data-label="Dá para fazer" className={`right num ${eco.makes === 0 ? 'danger-text strong' : ''}`}>{eco.makes === null ? '—' : d.links.some((l) => l.group.required) ? `até ${eco.makes}` : eco.makes}</td>
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

      {newIngredient && <QuickProductModal ingredient onClose={() => setNewIngredient(false)} onSaved={reloadAll} />}
      {entry && <PurchaseModal initialProduct={entry === 'new' ? undefined : entry} onClose={() => setEntry(null)} onDone={() => void reload()} />}
      {editing && (
        <RecipeModal dish={editing === 'new' ? null : editing} products={data} categories={categories.data ?? []}
          onClose={() => setEditing(null)} onSaved={reloadAll} onNewIngredient={() => { setEditing(null); setNewIngredient(true); }} />
      )}
    </div>
  );
}

type LineUnit = 'base' | 'kilo';
interface Line { productId: string; amount: number | null; unit: LineUnit }

const baseUnit = (m: Measure) => (m === 'volume' ? 'ml' : m === 'mass' ? 'g' : 'un');
const lineQty = (l: Line) => Math.round((l.amount ?? 0) * (l.unit === 'kilo' ? KILO : MILLI));

/**
 * Monta ou ajusta a ficha de um prato: o que sempre vai (insumos fixos) e o que o
 * garçom escolhe no pedido (sabor, bebida), com custo, margem e rendimento ao vivo.
 */
function RecipeModal({ dish, products, categories, onClose, onSaved, onNewIngredient }: {
  dish: Dish | null; products: Product[]; categories: Category[]; onClose: () => void; onSaved: () => void; onNewIngredient: () => void;
}) {
  const toast = useToast();
  const kitchen = categories.find((c) => /porc|refeic|lanche|prato|cozinha/.test(plain(c.name)))?.id ?? categories[0]?.id ?? '';
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(kitchen);
  const [price, setPrice] = useState<number | null>(dish?.pres.priceCents ?? null);
  const [lines, setLines] = useState<Line[]>(() => dish
    // Prato só de escolhas: o "próprio produto" sem estoque não é insumo.
    ? dish.pres.components.filter((c) => !(c.isSelf && !dish.product.stockTracked)).map((c) => ({ productId: c.productId, amount: c.qty / MILLI, unit: 'base' as const }))
    : [{ productId: '', amount: null, unit: 'base' }]);
  const [groupIds, setGroupIds] = useState<string[]>(() => (dish?.pres.optionGroups ?? []).map((g) => g.groupId));
  const groupQty = Object.fromEntries((dish?.pres.optionGroups ?? []).map((g) => [g.groupId, g.quantity]));
  const optionGroups = useLoad(() => api.get<OptionGroupView[]>('/api/option-groups'), [groupIds.join(',')]);
  const [busy, setBusy] = useState(false);
  // Insumos primeiro (fora do cardápio ou da categoria Insumos); depois os demais produtos com estoque.
  const tracked = products.filter((p) => p.active && p.stockTracked).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const isIngredient = (p: Product) => !p.menuVisible || /insum|ingredient/.test(plain(p.categoryName)) || !p.presentations.some((x) => x.active);
  const byId = new Map(products.map((p) => [p.id, p]));
  const groups = new Map((optionGroups.data ?? []).map((g) => [g.id, g]));
  const links = linksOf(groupIds.map((groupId) => ({ groupId, quantity: groupQty[groupId] ?? 1 })), groups);
  const productLinks = dish ? linksOf(dish.product.optionGroups ?? [], groups).filter((l) => !groupIds.includes(l.group.id)) : [];

  const rows = lines.map((l) => {
    const p = byId.get(l.productId);
    const qty = lineQty(l);
    return { l, p, qty, cost: p?.unitCostE4 && qty > 0 ? costOf(qty, p.unitCostE4) : null, makes: p && qty > 0 ? Math.max(0, Math.floor(p.stockQty / qty)) : null };
  });
  const filled = rows.filter((r) => r.l.productId || r.l.amount);
  const known = filled.filter((r) => r.cost !== null);
  const eco = economics(price ?? 0, {
    cost: known.length ? known.reduce((a, r) => a + r.cost!, 0) : null,
    makes: filled.length && filled.every((r) => r.makes !== null) ? Math.min(...filled.map((r) => r.makes!)) : null,
  }, [...links, ...productLinks], byId);
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    if (busy) return;
    if (!dish && name.trim().length < 2) return toast.error('Dê um nome para o prato (ex.: Porção de batata).');
    if (!dish && !categoryId) return toast.error('Escolha a categoria do prato.');
    if (price === null || price < 0) return toast.error('Informe o preço de venda do prato.');
    if (filled.some((r) => !r.p || r.qty <= 0)) return toast.error('Escolha o insumo e a quantidade de cada linha do que sempre vai.');
    if (!filled.length && !groupIds.length) return toast.error('Adicione ao menos um insumo ou uma escolha (ex.: Bebida: vodka ou cachaça).');
    const components = filled.map((r) => ({ productId: r.p!.id, qty: r.qty }));
    const optionGroupLinks = groupIds.map((groupId) => ({ groupId, quantity: groupQty[groupId] ?? 1 }));
    setBusy(true);
    try {
      if (dish) {
        await api.put(`/api/presentations/${dish.pres.id}/recipe`, { priceCents: price, components, optionGroups: optionGroupLinks });
        toast.success(`Ficha de ${dish.label} salva`);
      } else {
        // Prato sem estoque próprio: quem baixa são os insumos da ficha e o que o garçom escolher.
        await api.post('/api/products', {
          name: name.trim(), categoryId, measure: 'unit', packageQty: MILLI, stockTracked: false, minStock: 0, menuVisible: true, active: true,
          presentations: [{ name: name.trim(), priceCents: price, components, optionGroups: optionGroupLinks }],
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
          Custo <strong>{eco.cost ? range(eco.cost, formatBRL) : '—'}</strong>
          {links.length > 0 && price !== null && <> · preço <strong>{range(eco.price, formatBRL)}</strong></>}
          {eco.margin && price !== null && <> · margem <strong className={eco.margin[0] < 0 ? 'danger-text' : ''}>{range(eco.margin, (n) => `${n}%`)}</strong></>}
          {eco.makes !== null && <> · dá para fazer <strong>{links.some((l) => l.group.required) ? `até ${eco.makes}` : eco.makes}</strong></>}
        </span>
        <Button onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="primary" loading={busy} onClick={save}>{dish ? 'Salvar ficha' : 'Cadastrar prato'}</Button>
      </>}>
      <div className="stack">
        {!dish && (
          <div className="grid-2">
            <Field label="Nome do prato"><Input autoFocus placeholder="Ex.: Porção de batata, Caipirinha" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Categoria" hint="Define se sai na cozinha ou no balcão."><Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          </div>
        )}
        <div className="grid-2">
          <Field label="Preço de venda" hint={links.length ? 'Preço base; as opções com preço a mais somam no pedido.' : undefined}><MoneyInput value={price} onChange={setPrice} /></Field>
          {dish?.product.stockTracked && <p className="small muted" style={{ alignSelf: 'end' }}>Este produto também tem estoque próprio: a ficha substitui o que ele baixa.</p>}
        </div>

        <div className="section-label">1. Sempre vai (em 1 unidade)</div>
        {rows.length === 0 && <p className="small muted">Nada fixo: só o que o garçom escolher abaixo.</p>}
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
              <Button variant="plain" icon={<Trash2 size={15} />} aria-label={`Remover insumo ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        <div className="row wrap">
          <Button variant="plain" icon={<Plus size={15} />} onClick={() => setLines([...lines, { productId: '', amount: null, unit: 'base' }])}>Adicionar insumo</Button>
          <Button variant="plain" icon={<Carrot size={15} />} onClick={onNewIngredient}>Insumo não está na lista? Cadastrar</Button>
        </div>

        <div className="section-label">2. O garçom escolhe no pedido (opcional)</div>
        <OptionGroupsField value={groupIds} onChange={setGroupIds}
          example={`Ex.: Caipirinha → "Sabor" (Limão: baixa 1 un de limão · Morango +${formatBRL(300)}: baixa 100 g de morango) e "Bebida" (Vodka Smirnoff +${formatBRL(500)}: baixa 50 ml da Smirnoff · Cachaça 51: baixa 50 ml da 51). No pedido o garçom escolhe e o estoque baixa o que foi escolhido.`}
          emptyText="Sem escolhas: sai sempre igual." />
        {productLinks.length > 0 && <p className="tiny muted">Também pergunta (cadastro do produto): {productLinks.map((l) => l.group.name).join(', ')}.</p>}
        <p className="tiny muted">Cada venda de 1 {dish ? dish.label : 'prato'} baixa o que sempre vai e o que o garçom escolheu, junto com o pedido. Cancelar o item devolve. Custo = quantidade × custo médio das entradas.</p>
      </div>
    </Modal>
  );
}
