import { BASE_UNIT, buyModeOf, costOf, packName, unitName, type Measure, type Packaging } from '@rupbar/core';
import { Beer, Boxes, Camera, ImageOff, ListChecks, Plus, Search, Trash2, Wine } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';
import { OptionGroupsField } from '../components/OptionGroups';
import { BuyModePicker, CodeTag, LevelChip, QtyEntry, StockQty } from '../components/stock-units';
import { Button, Card, Confirm, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Switch, Tabs, Textarea, useToast } from '../components/ui';
import { api, qs } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { draftFromPackaging, packagingFromDraft, previewPackaging, qtyDraftFrom, qtyOf, type PackDraft, type QtyDraft } from '../lib/stock-units';
import '../styles/stock.css';
import { BucketModal, isBucket } from './BucketModal';
import { ComboModal } from './ComboModal';
import { HalfPartsField } from './HalfParts';
import { QuickProductModal } from './QuickProduct';

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  internalCode: string | null;
  barcode: string | null;
  description: string | null;
  supplierId: string | null;
  photoUrl: string | null;
  measure: Measure;
  packageQty: number;
  packageLabel: string | null;
  /** Nome da unidade avulsa ("lata") quando a embalagem tem várias. */
  unitLabel: string | null;
  /** Menor dose vendida do próprio produto (milli), se houver. */
  doseQty: number | null;
  stockTracked: boolean;
  stockQty: number;
  minStock: number;
  level: 'ok' | 'low' | 'out' | 'negative';
  packages: { closed: number; openRemaining: number; hasOpen: boolean } | null;
  theoreticalYield: number | null;
  unitCostE4: number | null;
  expiryTracked: boolean;
  menuVisible: boolean;
  station: string;
  stationOverride: string | null;
  active: boolean;
  presentations: {
    id: string;
    name: string;
    priceCents: number;
    menuVisible: boolean;
    active: boolean;
    components: { productId: string; productName: string; qty: number; measure: Measure; isSelf: boolean }[];
    available: number | null;
    /** Escolhas só desta apresentação (ex.: Dose com energético). */
    optionGroups?: { groupId: string; quantity: number }[];
    /** Meio a meio: as porções que podem ser metade. */
    halves?: string[];
  }[];
  /** Escolhas pedidas ao lançar (ex.: energético e gelo da dose). */
  optionGroupIds?: string[];
  /** Com a quantidade de cada escolha (combos: 4 energéticos, 5 gelos). */
  optionGroups?: { groupId: string; quantity: number }[];
}

export interface Category {
  id: string;
  name: string;
  station: string;
}

export const LEVEL_BADGE: Record<Product['level'], ReactElement> = {
  ok: <LevelChip level="ok" />,
  low: <LevelChip level="low" />,
  out: <LevelChip level="out" />,
  negative: <LevelChip level="negative" />,
};

/** Embalagem do produto no formato usado pelas conversões. */
export function packagingOf(p: Pick<Product, 'measure' | 'packageQty' | 'packageLabel' | 'unitLabel'>): Packaging {
  return { measure: p.measure, packageQty: p.packageQty, packageLabel: p.packageLabel, unitLabel: p.unitLabel };
}

export function ProductsPage() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | 'advanced' | null>(null);
  const [combo, setCombo] = useState(false);
  const [bucket, setBucket] = useState<Product | 'new' | null>(null);
  const [removing, setRemoving] = useState<Product | null>(null);
  const toast = useToast();
  const cats = useLoad(() => api.get<Category[]>('/api/categories'));
  const { data, error, reload } = useLoad(() => api.get<Product[]>(`/api/products${qs({ q, categoryId: cat, all: showInactive ? 1 : undefined })}`), [q, cat, showInactive]);
  useRealtime(['stock'], () => void reload());

  return (
    <div className="stack-l">
      <PageHeader
        title="Produtos"
        subtitle="Cadastro único: o mesmo produto é usado no cardápio, no estoque e nas fichas técnicas."
        actions={can('products.manage') && <><Button variant="plain" onClick={() => setEditing('advanced')}>Cadastro completo</Button><Button icon={<Beer size={16} />} onClick={() => setBucket('new')}>Novo balde</Button><Button icon={<Boxes size={16} />} onClick={() => setCombo(true)}>Novo combo</Button><Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>Novo produto</Button></>}
      />
      <div className="row wrap">
        <div className="input-group" style={{ width: 300, maxWidth: '100%' }}>
          <Search size={16} className="prefix" />
          <Input aria-label="Buscar produtos" placeholder="Nome, código (ex.: 0007) ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 220 }}>
          <option value="">Todas as categorias</option>
          {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Mostrar inativos</label>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? <Loading /> : data.length === 0 ? (
        <Card><Empty icon={<Wine size={40} />} title="Nenhum produto">Cadastre bebidas, porções, ingredientes, essências e carvão.</Empty></Card>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Produto</th><th>Categoria</th><th>Apresentações</th><th className="right">Estoque</th><th>Situação</th>{can('products.manage') && <th aria-label="Excluir" />}</tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => can('products.manage') && (isBucket(p) ? setBucket(p) : setEditing(p))} style={{ opacity: p.active ? 1 : 0.5 }}>
                    <td>
                      <div className="row">
                        {p.photoUrl ? <img src={p.photoUrl} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover' }} /> : <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--fill)' }} />}
                        <div>
                          <div className="row product-name-line"><CodeTag code={p.internalCode} /><span className="strong">{p.name}</span></div>
                          {!p.menuVisible && <div className="tiny muted">fora do cardápio</div>}
                        </div>
                      </div>
                    </td>
                    <td className="muted">{p.categoryName}</td>
                    <td className="small">{p.presentations.filter((x) => x.active).map((x) => `${x.name} ${formatBRL(x.priceCents)}`).join(' · ') || <span className="muted">—</span>}</td>
                    <td className="right num">
                      {p.stockTracked ? <StockQty qty={p.stockQty} packaging={packagingOf(p)} /> : <span className="muted">não controlado</span>}
                    </td>
                    <td>{p.stockTracked ? LEVEL_BADGE[p.level] : null}</td>
                    {can('products.manage') && (
                      <td className="right">
                        <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label={`Excluir ${p.name}`} title="Excluir produto"
                          onClick={(e) => { e.stopPropagation(); setRemoving(p); }} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {combo && <ComboModal onClose={() => setCombo(false)} onSaved={() => void reload()} />}
      {bucket && <BucketModal product={bucket === 'new' ? undefined : bucket} onClose={() => setBucket(null)} onSaved={() => void reload()} />}
      {editing === 'new' ? <QuickProductModal onClose={() => setEditing(null)} onSaved={() => void reload()} /> : editing && <ProductEditor product={editing === 'advanced' ? null : editing} categories={cats.data ?? []} onClose={() => setEditing(null)} onSaved={reload} onRemove={(p) => { setEditing(null); setRemoving(p); }} />}
      {removing && (
        <Confirm title={`Excluir ${removing.name}?`} confirmLabel="Excluir produto" danger onClose={() => setRemoving(null)}
          message={<>
            Some do cardápio, do estoque, das escolhas e do painel online. As vendas antigas continuam nos relatórios com o nome.
            {removing.stockTracked && removing.stockQty > 0 && <><br /><strong>Ainda tem <StockQty qty={removing.stockQty} packaging={packagingOf(removing)} /> em estoque</strong>, que sai junto.</>}
          </>}
          onConfirm={async () => { await api.del(`/api/products/${removing.id}`); toast.success(`${removing.name} excluído`); void reload(); }} />
      )}
    </div>
  );
}

interface PresDraft {
  id?: string;
  name: string;
  priceCents: number | null;
  menuVisible: boolean;
  active: boolean;
  mode: 'self' | 'recipe';
  selfQty: number | null;
  components: { productId: string; qty: number | null }[];
  /** Escolhas só desta apresentação, com a quantidade (combos). */
  optionGroupIds: string[];
  optionQty: Record<string, number>;
  showOptions: boolean;
  /** Meio a meio: porções que podem ser metade. */
  halves?: string[];
}

function toDraft(p: Product | null): PresDraft[] {
  if (!p) return [{ name: 'Unidade', priceCents: null, menuVisible: true, active: true, mode: 'self', selfQty: 1, components: [], optionGroupIds: [], optionQty: {}, showOptions: false }];
  return p.presentations.map((pr) => {
    const self = pr.components.length === 1 && pr.components[0]!.isSelf;
    return {
      id: pr.id, name: pr.name, priceCents: pr.priceCents, menuVisible: pr.menuVisible, active: pr.active,
      mode: self ? 'self' : 'recipe',
      selfQty: self ? pr.components[0]!.qty / 1000 : 1,
      components: self ? [] : pr.components.map((c) => ({ productId: c.productId, qty: c.qty / 1000 })),
      optionGroupIds: (pr.optionGroups ?? []).map((g) => g.groupId),
      optionQty: Object.fromEntries((pr.optionGroups ?? []).map((g) => [g.groupId, g.quantity])),
      showOptions: !!pr.optionGroups?.length,
      halves: pr.halves?.length ? pr.halves : undefined,
    };
  });
}

function ProductEditor({ product, categories, onClose, onSaved, onRemove }: { product: Product | null; categories: Category[]; onClose: () => void; onSaved: () => void; onRemove?: (p: Product) => void }) {
  const toast = useToast();
  const suppliers = useLoad(() => api.get<{ id: string; name: string }[]>('/api/suppliers').catch(() => []));
  const all = useLoad(() => api.get<Product[]>('/api/products'));
  const nextCode = useLoad(() => (product ? Promise.resolve(null) : api.get<{ code: string }>('/api/products/next-code').catch(() => null)));
  const [tab, setTab] = useState<'geral' | 'estoque' | 'apresentacoes' | 'escolhas'>('geral');
  const [optionGroupIds, setOptionGroupIds] = useState<string[]>(product?.optionGroupIds ?? []);
  const [optionQty, setOptionQty] = useState<Record<string, number>>(() => Object.fromEntries((product?.optionGroups ?? []).map((g) => [g.groupId, g.quantity])));
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [f, setF] = useState({
    name: product?.name ?? '',
    categoryId: product?.categoryId ?? categories[0]?.id ?? '',
    internalCode: product?.internalCode ?? '',
    barcode: product?.barcode ?? '',
    description: product?.description ?? '',
    supplierId: product?.supplierId ?? '',
    stockTracked: product?.stockTracked ?? true,
    expiryTracked: product?.expiryTracked ?? false,
    menuVisible: product?.menuVisible ?? true,
    station: product?.stationOverride ?? '',
    active: product?.active ?? true,
    packageCost: product?.unitCostE4 ? Math.round((product.unitCostE4 * product.packageQty) / 10_000_000) : (null as number | null),
  });
  const [pack, setPack] = useState<PackDraft>(() => (product ? draftFromPackaging(packagingOf(product)) : draftFromPackaging({ measure: 'unit', packageQty: 1000 })));
  const packaging = previewPackaging(pack);
  const [min, setMin] = useState<QtyDraft>(() => qtyDraftFrom(product?.minStock ?? 0, product ? packagingOf(product) : packaging));
  const [initialCost] = useState(f.packageCost);
  const [pres, setPres] = useState<PresDraft[]>(() => toDraft(product));
  const unit = BASE_UNIT[packaging.measure];
  const ingredients = useMemo(() => (all.data ?? []).filter((p) => p.id !== product?.id && p.stockTracked), [all.data, product?.id]);

  const changePack = (next: PackDraft) => {
    if (next.buyMode !== pack.buyMode) setMin({ ...min, mode: next.buyMode === 'single' ? 'unit' : 'pack' });
    setPack(next);
  };

  const save = async () => {
    const pk = packagingFromDraft(pack);
    if (!pk.ok) { setTab('estoque'); return toast.error(pk.error); }
    if (min.amount !== null && min.amount < 0) return toast.error('O estoque mínimo não pode ser negativo.');
    for (const p of pres) {
      if (!p.name.trim()) { setTab('apresentacoes'); return toast.error('Dê um nome para a apresentação (ex.: Unidade, Dose 50 ml).'); }
      if (p.priceCents === null) return toast.error(`Informe o preço de "${p.name}".`);
      if (p.mode === 'recipe' && p.components.some((c) => !c.productId || !c.qty)) return toast.error(`Complete a ficha técnica de "${p.name}".`);
      if (p.halves && p.halves.length < 2) { setTab('apresentacoes'); return toast.error(`Escolha ao menos duas porções no meio a meio "${p.name}".`); }
    }
    const packageQty = pk.value.packageQty;
    setBusy(true);
    try {
      const body = {
        name: f.name, categoryId: f.categoryId, internalCode: f.internalCode.trim() || null, barcode: f.barcode || null, description: f.description || null,
        supplierId: f.supplierId || null, measure: pk.value.measure, packageQty, packageLabel: pk.value.packageLabel || null, unitLabel: pk.value.unitLabel || null,
        stockTracked: f.stockTracked, minStock: qtyOf(min, pk.value), expiryTracked: f.expiryTracked, menuVisible: f.menuVisible, station: f.station || null, active: f.active,
        // Só envia o custo se foi alterado aqui (preserva o custo médio exato das entradas).
        unitCostE4: f.packageCost !== null && f.packageCost !== initialCost ? Math.round((f.packageCost * 1000 * 10_000) / packageQty) : undefined,
        optionGroups: optionGroupIds.map((groupId) => ({ groupId, quantity: optionQty[groupId] ?? 1 })),
        presentations: pres.map((p, i) => ({
          id: p.id, name: p.name, priceCents: p.priceCents ?? 0, menuVisible: p.menuVisible, active: p.active, sortOrder: i,
          components: p.mode === 'self' ? [{ productId: null, qty: Math.round((p.selfQty ?? 1) * 1000) }] : p.components.map((c) => ({ productId: c.productId, qty: Math.round((c.qty ?? 0) * 1000) })),
          optionGroups: p.optionGroupIds.map((groupId) => ({ groupId, quantity: p.optionQty[groupId] ?? 1 })),
          ...(p.halves ? { halves: p.halves } : {}),
        })),
      };
      const r = product
        ? await api.put<{ id: string; internalCode: string | null }>(`/api/products/${product.id}`, body)
        : await api.post<{ id: string; internalCode: string | null }>('/api/products', body);
      if (photo) await api.upload(`/api/products/${r.id}/photo`, photo);
      toast.success(r.internalCode ? `Produto ${r.internalCode} salvo` : 'Produto salvo');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const unitCostE4 = f.packageCost && packaging.packageQty ? Math.round((f.packageCost * 1000 * 10_000) / packaging.packageQty) : null;
  const single = buyModeOf(packaging) === 'single';
  const updatePres = (i: number, patch: Partial<PresDraft>) => setPres(pres.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Modal title={product ? product.name : 'Novo produto'} wide onClose={onClose}
      footer={<>
        {product && onRemove && <Button variant="plain" className="danger-text" icon={<Trash2 size={15} />} onClick={() => onRemove(product)} style={{ marginRight: 'auto' }}>Excluir produto</Button>}
        <Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!f.name.trim() || !f.categoryId} onClick={save}>Salvar</Button>
      </>}>
      <Tabs value={tab} onChange={setTab} options={[{ value: 'geral', label: 'Geral' }, { value: 'estoque', label: 'Estoque e custo' }, { value: 'apresentacoes', label: `Apresentações e preços (${pres.length})` }, { value: 'escolhas', label: `Escolhas no pedido${optionGroupIds.length ? ` (${optionGroupIds.length})` : ''}` }]} />
      {tab === 'escolhas' && (
        <div className="stack">
          {pres.length > 1 && <p className="small banner">Estas escolhas valem para todas as apresentações ({pres.map((p) => p.name || 'sem nome').join(', ')}). Para pedir só numa (ex.: Dose com energético), use Apresentações e preços → Escolhas só desta apresentação.</p>}
          <OptionGroupsField value={optionGroupIds} onChange={setOptionGroupIds} qty={optionQty} onQtyChange={setOptionQty} />
        </div>
      )}
      {tab === 'geral' && (
        <div className="stack">
          <div className="row top" style={{ gap: 16 }}>
            <label style={{ cursor: 'pointer' }} title="Foto">
              <div style={{ width: 88, height: 88, borderRadius: 18, background: 'var(--fill)', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                {photo ? <img src={URL.createObjectURL(photo)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : product?.photoUrl ? <img src={product.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Camera size={24} className="muted" />}
              </div>
              <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </label>
            <div className="stack grow">
              <Field label="Nome *"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <div className="grid-2">
                <Field label="Categoria *">
                  <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
                </Field>
                <Field label="Local de preparo" hint="Padrão: o da categoria.">
                  <Select value={f.station} onChange={(e) => setF({ ...f, station: e.target.value })}>
                    <option value="">Igual à categoria</option>
                    <option value="kitchen">Cozinha</option>
                    <option value="bar">Balcão/Bebidas</option>
                    <option value="none">Sem preparo</option>
                  </Select>
                </Field>
              </div>
            </div>
          </div>
          {product?.photoUrl && !photo && <Button variant="plain" icon={<ImageOff size={15} />} style={{ alignSelf: 'flex-start' }} onClick={async () => { await api.del(`/api/products/${product.id}/photo`); toast.success('Foto removida'); onSaved(); }}>Remover foto</Button>}
          <div className="grid-3">
            <Field label="Código interno" hint={product ? 'Pode trocar; em branco mantém o atual.' : `Em branco: gerado automaticamente${nextCode.data ? ` (${nextCode.data.code})` : ''}.`}>
              <Input className="mono" value={f.internalCode} placeholder={nextCode.data ? `Automático: ${nextCode.data.code}` : product?.internalCode ?? 'Automático'} onChange={(e) => setF({ ...f, internalCode: e.target.value })} />
            </Field>
            <Field label="Código de barras" hint="Clique aqui e bipe o produto com o leitor."><Input inputMode="numeric" data-barcode="field" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></Field>
            <Field label="Fornecedor">
              <Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
                <option value="">—</option>
                {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Descrição"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Switch checked={f.menuVisible} onChange={(v) => setF({ ...f, menuVisible: v })} label="Visível no cardápio" description="Desative para ingredientes (pão, limão, gelo) e insumos." />
          <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Produto ativo" />
        </div>
      )}
      {tab === 'estoque' && (
        <div className="stack">
          <Switch checked={f.stockTracked} onChange={(v) => setF({ ...f, stockTracked: v })} label="Controlar estoque" description="Desative para itens preparados cujo estoque é controlado pelos ingredientes (ficha técnica)." />
          <div className="section-label">Como você compra este produto?</div>
          <BuyModePicker value={pack} onChange={changePack} lockedMeasure={product && product.stockQty !== 0 ? product.measure : null} />
          {product && product.stockQty !== 0 && <p className="tiny muted">Com saldo, só dá para trocar entre unidade avulsa e fardo. Para mudar para ml ou g, zere o saldo com um ajuste.</p>}
          {f.stockTracked && (
            <div className="grid-3">
              <QtyEntry label="Estoque mínimo" packaging={packaging} value={min} onChange={setMin} suggest={false} hint="Gera alerta e sugestão de reposição." />
              <Field label={`Custo por ${packName(packaging, 1)}`} hint={unitCostE4 && !single && packaging.measure === 'unit'
                ? `Custo médio das entradas. Por ${unitName(packaging, 1)}: ${formatBRL(costOf(1000, unitCostE4))}.`
                : 'Atualizado automaticamente pelas entradas (custo médio).'}>
                <MoneyInput value={f.packageCost} onChange={(v) => setF({ ...f, packageCost: v })} />
              </Field>
              <Field label="Saldo atual"><div className="input readonly-box">{product ? <StockQty qty={product.stockQty} packaging={packagingOf(product)} inline /> : '—'}</div></Field>
            </div>
          )}
          {f.stockTracked && <Switch checked={f.expiryTracked} onChange={(v) => setF({ ...f, expiryTracked: v })} label="Controlar validade por lote" description="As entradas pedem data de validade; o consumo segue a ordem de vencimento." />}
          {product?.theoreticalYield && product.measure !== 'unit' && (
            <div className="banner">Rendimento teórico: 1 {packName(packagingOf(product), 1)} rende <strong>{product.theoreticalYield}</strong> {product.measure === 'mass' ? 'porções' : 'doses'} da menor apresentação.</div>
          )}
          <p className="small muted">Para alterar o saldo, use Estoque → Entradas, Ajustes ou Inventário. Toda movimentação é registrada.</p>
        </div>
      )}
      {tab === 'apresentacoes' && (
        <div className="stack">
          <p className="small muted">Cada apresentação tem seu preço e o que consome do estoque. Ex.: whisky com “Dose 30 ml”, “Dose 50 ml” e “Dose dupla 100 ml” usando a mesma garrafa; ou um drink/hambúrguer com ficha técnica de vários ingredientes.</p>
          {pres.map((p, i) => {
            const cost = p.mode === 'self'
              ? (unitCostE4 && p.selfQty ? costOf(Math.round(p.selfQty * 1000), unitCostE4) : null)
              : p.components.reduce<number | null>((a, c) => {
                  const ing = ingredients.find((x) => x.id === c.productId);
                  return ing?.unitCostE4 && c.qty ? (a ?? 0) + costOf(Math.round(c.qty * 1000), ing.unitCostE4) : a;
                }, null);
            return (
              <Card key={p.id ?? i} tight>
                <div className="stack">
                  <div className="row top">
                    <Field label="Nome" className="grow"><Input value={p.name} onChange={(e) => updatePres(i, { name: e.target.value })} /></Field>
                    <Field label={p.halves ? 'Preço mínimo' : 'Preço de venda'} hint={p.halves ? 'Cobra a metade mais cara.' : undefined}><MoneyInput value={p.priceCents} onChange={(v) => updatePres(i, { priceCents: v })} /></Field>
                    <Button variant="plain" icon={<Trash2 size={16} />} aria-label="Remover" style={{ marginTop: 22 }} disabled={pres.length === 1} onClick={() => setPres(pres.filter((_, j) => j !== i))} />
                  </div>
                  {!p.halves && <div className="row wrap">
                    <span className="label">Consome:</span>
                    <div className="segmented">
                      <button type="button" className={p.mode === 'self' ? 'active' : ''} onClick={() => updatePres(i, { mode: 'self' })}>Deste produto</button>
                      <button type="button" className={p.mode === 'recipe' ? 'active' : ''} onClick={() => updatePres(i, { mode: 'recipe', components: p.components.length ? p.components : [{ productId: '', qty: null }] })}>Ficha técnica</button>
                    </div>
                    {p.mode === 'self' && <div style={{ width: 160 }}><DecimalInput value={p.selfQty} onChange={(v) => updatePres(i, { selfQty: v })} suffix={unit} /></div>}
                    <span className="grow" />
                    {cost !== null && p.priceCents ? <span className="small muted">Custo estimado {formatBRL(cost)} · margem {Math.round(((p.priceCents - cost) / p.priceCents) * 100)}%</span> : null}
                  </div>}
                  {p.mode === 'recipe' && (
                    <div className="col">
                      {p.components.map((c, k) => {
                        const ing = ingredients.find((x) => x.id === c.productId);
                        return (
                          <div key={k} className="row">
                            <Select value={c.productId} className="grow" onChange={(e) => updatePres(i, { components: p.components.map((x, m) => (m === k ? { ...x, productId: e.target.value } : x)) })}>
                              <option value="">Ingrediente…</option>
                              {ingredients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                            </Select>
                            <div style={{ width: 150 }}><DecimalInput value={c.qty} onChange={(v) => updatePres(i, { components: p.components.map((x, m) => (m === k ? { ...x, qty: v } : x)) })} suffix={ing ? BASE_UNIT[ing.measure] : ''} /></div>
                            <Button variant="plain" icon={<Trash2 size={15} />} aria-label="Remover ingrediente" onClick={() => updatePres(i, { components: p.components.filter((_, m) => m !== k) })} />
                          </div>
                        );
                      })}
                      <Button variant="plain" icon={<Plus size={15} />} style={{ alignSelf: 'flex-start' }} onClick={() => updatePres(i, { components: [...p.components, { productId: '', qty: null }] })}>Ingrediente</Button>
                    </div>
                  )}
                  {p.halves && (
                    <div className="stack pres-halves">
                      <span className="label">Meio a meio: de quais porções puxa (cobra a mais cara, baixa metade de cada)</span>
                      <HalfPartsField value={p.halves} exclude={p.id} onChange={(halves) => updatePres(i, { halves })} />
                    </div>
                  )}
                  <div className="pres-options">
                    <Button size="small" variant="plain" icon={<ListChecks size={15} />} aria-expanded={p.showOptions} onClick={() => updatePres(i, { showOptions: !p.showOptions })}>
                      Escolhas só desta apresentação{p.optionGroupIds.length ? ` (${p.optionGroupIds.length})` : ''}
                    </Button>
                    {p.showOptions && (
                      <OptionGroupsField value={p.optionGroupIds} onChange={(ids) => updatePres(i, { optionGroupIds: ids })} qty={p.optionQty} onQtyChange={(q) => updatePres(i, { optionQty: q })}
                        emptyText="Esta apresentação usa só as escolhas do produto (aba Escolhas no pedido)."
                        example="Ex.: “Dose com energético” pede o energético; a dose pura e a garrafa fechada do mesmo produto não pedem. Todas baixam da mesma garrafa." />
                    )}
                  </div>
                  <div className="row">
                    <label className="check small"><input type="checkbox" checked={p.menuVisible} onChange={(e) => updatePres(i, { menuVisible: e.target.checked })} /> No cardápio</label>
                    <label className="check small"><input type="checkbox" checked={p.active} onChange={(e) => updatePres(i, { active: e.target.checked })} /> Ativa</label>
                  </div>
                </div>
              </Card>
            );
          })}
          {pres.length === 0 && <p className="small banner">Este produto não está à venda (é ingrediente ou adicional). Adicione uma apresentação com o preço para ele aparecer no cardápio.</p>}
          <Button icon={<Plus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => {
            // Já vem com o nome do produto (o cardápio não repete o nome); a 2ª apresentação começa em branco (ex.: Dose 50 ml).
            const name = f.name.trim();
            // Ingrediente que passa a ser vendido: volta para o cardápio.
            if (!pres.length) setF({ ...f, menuVisible: true });
            setPres([...pres, { name: name && !pres.some((p) => p.name.trim() === name) ? name : '', priceCents: null, menuVisible: true, active: true, mode: 'self', selfQty: packaging.measure === 'volume' ? 50 : 1, components: [], optionGroupIds: [], optionQty: {}, showOptions: false }]);
          }}>Adicionar apresentação</Button>
        </div>
      )}
    </Modal>
  );
}
