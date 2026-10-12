import { BASE_UNIT, costOf, formatQty, MEASURE_LABEL, type Measure } from '@rupbar/core';
import { Camera, ImageOff, Plus, Search, Trash2, Wine } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';
import { Badge, Button, Card, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Switch, Tabs, Textarea, useToast } from '../components/ui';
import { api, qs } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';

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
  }[];
}

export interface Category {
  id: string;
  name: string;
  station: string;
}

export const LEVEL_BADGE: Record<Product['level'], ReactElement> = {
  ok: <Badge color="green">OK</Badge>,
  low: <Badge color="orange">Baixo</Badge>,
  out: <Badge color="red">Zerado</Badge>,
  negative: <Badge color="red">Negativo</Badge>,
};

export function ProductsPage() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const cats = useLoad(() => api.get<Category[]>('/api/categories'));
  const { data, error, reload } = useLoad(() => api.get<Product[]>(`/api/products${qs({ q, categoryId: cat, all: showInactive ? 1 : undefined })}`), [q, cat, showInactive]);
  useRealtime(['stock'], () => void reload());

  return (
    <div className="stack-l">
      <PageHeader
        title="Produtos"
        subtitle="Cadastro único: o mesmo produto é usado no cardápio, no estoque e nas fichas técnicas."
        actions={can('products.manage') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>Novo produto</Button>}
      />
      <div className="row wrap">
        <div className="input-group" style={{ width: 300, maxWidth: '100%' }}>
          <Search size={16} className="prefix" />
          <Input placeholder="Nome, código ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} />
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
              <thead><tr><th>Produto</th><th>Categoria</th><th>Apresentações</th><th className="right">Estoque</th><th>Situação</th></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => can('products.manage') && setEditing(p)} style={{ opacity: p.active ? 1 : 0.5 }}>
                    <td>
                      <div className="row">
                        {p.photoUrl ? <img src={p.photoUrl} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover' }} /> : <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--fill)' }} />}
                        <div>
                          <div className="strong">{p.name}</div>
                          <div className="tiny muted">{p.internalCode ?? ''}{p.menuVisible ? '' : ' · fora do cardápio'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="muted">{p.categoryName}</td>
                    <td className="small">{p.presentations.filter((x) => x.active).map((x) => `${x.name} ${formatBRL(x.priceCents)}`).join(' · ') || <span className="muted">—</span>}</td>
                    <td className="right num">
                      {p.stockTracked ? (
                        <>
                          <div>{formatQty(p.stockQty, p.measure)}</div>
                          {p.packages && p.packageQty > 1000 && <div className="tiny muted">{p.packages.closed} fechada(s){p.packages.hasOpen ? ` + ${formatQty(p.packages.openRemaining, p.measure)} aberta` : ''}</div>}
                        </>
                      ) : <span className="muted">não controlado</span>}
                    </td>
                    <td>{p.stockTracked ? LEVEL_BADGE[p.level] : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {editing && <ProductEditor product={editing === 'new' ? null : editing} categories={cats.data ?? []} onClose={() => setEditing(null)} onSaved={reload} />}
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
}

function toDraft(p: Product | null): PresDraft[] {
  if (!p) return [{ name: 'Unidade', priceCents: null, menuVisible: true, active: true, mode: 'self', selfQty: 1, components: [] }];
  return p.presentations.map((pr) => {
    const self = pr.components.length === 1 && pr.components[0]!.isSelf;
    return {
      id: pr.id, name: pr.name, priceCents: pr.priceCents, menuVisible: pr.menuVisible, active: pr.active,
      mode: self ? 'self' : 'recipe',
      selfQty: self ? pr.components[0]!.qty / 1000 : 1,
      components: self ? [] : pr.components.map((c) => ({ productId: c.productId, qty: c.qty / 1000 })),
    };
  });
}

function ProductEditor({ product, categories, onClose, onSaved }: { product: Product | null; categories: Category[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const suppliers = useLoad(() => api.get<{ id: string; name: string }[]>('/api/suppliers').catch(() => []));
  const all = useLoad(() => api.get<Product[]>('/api/products'));
  const [tab, setTab] = useState<'geral' | 'estoque' | 'apresentacoes'>('geral');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [f, setF] = useState({
    name: product?.name ?? '',
    categoryId: product?.categoryId ?? categories[0]?.id ?? '',
    internalCode: product?.internalCode ?? '',
    barcode: product?.barcode ?? '',
    description: product?.description ?? '',
    supplierId: product?.supplierId ?? '',
    measure: product?.measure ?? ('unit' as Measure),
    packageQty: (product?.packageQty ?? 1000) / 1000 as number | null,
    packageLabel: product?.packageLabel ?? '',
    stockTracked: product?.stockTracked ?? true,
    minStock: (product?.minStock ?? 0) / 1000 as number | null,
    expiryTracked: product?.expiryTracked ?? false,
    menuVisible: product?.menuVisible ?? true,
    station: product?.stationOverride ?? '',
    active: product?.active ?? true,
    packageCost: product?.unitCostE4 ? Math.round((product.unitCostE4 * product.packageQty) / 10_000_000) : (null as number | null),
  });
  const [initialCost] = useState(f.packageCost);
  const [pres, setPres] = useState<PresDraft[]>(() => toDraft(product));
  const unit = BASE_UNIT[f.measure];
  const ingredients = useMemo(() => (all.data ?? []).filter((p) => p.id !== product?.id && p.stockTracked), [all.data, product?.id]);

  const save = async () => {
    if (!f.packageQty || f.packageQty <= 0) return toast.error('Informe o conteúdo da embalagem.');
    for (const p of pres) {
      if (p.priceCents === null) return toast.error(`Informe o preço de "${p.name}".`);
      if (p.mode === 'recipe' && p.components.some((c) => !c.productId || !c.qty)) return toast.error(`Complete a ficha técnica de "${p.name}".`);
    }
    const packageQty = Math.round(f.packageQty * 1000);
    setBusy(true);
    try {
      const body = {
        name: f.name, categoryId: f.categoryId, internalCode: f.internalCode || null, barcode: f.barcode || null, description: f.description || null,
        supplierId: f.supplierId || null, measure: f.measure, packageQty, packageLabel: f.packageLabel || null, stockTracked: f.stockTracked,
        minStock: Math.round((f.minStock ?? 0) * 1000), expiryTracked: f.expiryTracked, menuVisible: f.menuVisible, station: f.station || null, active: f.active,
        // Só envia o custo se foi alterado aqui (preserva o custo médio exato das entradas).
        unitCostE4: f.packageCost !== null && f.packageCost !== initialCost ? Math.round((f.packageCost * 1000 * 10_000) / packageQty) : undefined,
        presentations: pres.map((p, i) => ({
          id: p.id, name: p.name, priceCents: p.priceCents ?? 0, menuVisible: p.menuVisible, active: p.active, sortOrder: i,
          components: p.mode === 'self' ? [{ productId: null, qty: Math.round((p.selfQty ?? 1) * 1000) }] : p.components.map((c) => ({ productId: c.productId, qty: Math.round((c.qty ?? 0) * 1000) })),
        })),
      };
      const r = product ? await api.put<{ id: string }>(`/api/products/${product.id}`, body) : await api.post<{ id: string }>('/api/products', body);
      if (photo) await api.upload(`/api/products/${r.id}/photo`, photo);
      toast.success('Produto salvo');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const unitCostE4 = f.packageCost && f.packageQty ? Math.round((f.packageCost * 1000 * 10_000) / (f.packageQty * 1000)) : null;
  const updatePres = (i: number, patch: Partial<PresDraft>) => setPres(pres.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Modal title={product ? product.name : 'Novo produto'} wide onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!f.name.trim() || !f.categoryId} onClick={save}>Salvar</Button></>}>
      <Tabs value={tab} onChange={setTab} options={[{ value: 'geral', label: 'Geral' }, { value: 'estoque', label: 'Estoque e custo' }, { value: 'apresentacoes', label: `Apresentações e preços (${pres.length})` }]} />
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
            <Field label="Código interno"><Input value={f.internalCode} onChange={(e) => setF({ ...f, internalCode: e.target.value })} /></Field>
            <Field label="Código de barras"><Input inputMode="numeric" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></Field>
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
          <div className="grid-3">
            <Field label="Unidade de medida" hint={product && product.stockQty !== 0 ? 'Zere o saldo para alterar.' : undefined}>
              <Select value={f.measure} disabled={!!product && product.stockQty !== 0} onChange={(e) => setF({ ...f, measure: e.target.value as Measure })}>
                {(Object.keys(MEASURE_LABEL) as Measure[]).map((m) => <option key={m} value={m}>{MEASURE_LABEL[m]}</option>)}
              </Select>
            </Field>
            <Field label={`Conteúdo da embalagem (${unit})`} hint={f.measure === 'volume' ? 'Ex.: garrafa de 1 L = 1000' : f.measure === 'mass' ? 'Ex.: pacote de 50 g = 50' : 'Ex.: caixa com 12 = 12'}>
              <DecimalInput value={f.packageQty} onChange={(v) => setF({ ...f, packageQty: v })} suffix={unit} />
            </Field>
            <Field label="Nome da embalagem"><Input value={f.packageLabel} onChange={(e) => setF({ ...f, packageLabel: e.target.value })} placeholder="garrafa, lata, pacote…" /></Field>
          </div>
          {f.stockTracked && (
            <div className="grid-3">
              <Field label={`Estoque mínimo (${unit})`} hint="Gera alerta e sugestão de reposição."><DecimalInput value={f.minStock} onChange={(v) => setF({ ...f, minStock: v })} suffix={unit} /></Field>
              <Field label="Custo da embalagem" hint="Atualizado automaticamente pelas entradas (custo médio)."><MoneyInput value={f.packageCost} onChange={(v) => setF({ ...f, packageCost: v })} /></Field>
              <Field label="Saldo atual"><div className="input num" style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-3)' }}>{product ? formatQty(product.stockQty, product.measure) : '—'}</div></Field>
            </div>
          )}
          {f.stockTracked && <Switch checked={f.expiryTracked} onChange={(v) => setF({ ...f, expiryTracked: v })} label="Controlar validade por lote" description="As entradas pedem data de validade; o consumo segue a ordem de vencimento." />}
          {product?.theoreticalYield && <div className="banner">Rendimento teórico: <strong>{product.theoreticalYield}</strong> doses da menor apresentação por embalagem.</div>}
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
                    <Field label="Preço de venda"><MoneyInput value={p.priceCents} onChange={(v) => updatePres(i, { priceCents: v })} /></Field>
                    <Button variant="plain" icon={<Trash2 size={16} />} aria-label="Remover" style={{ marginTop: 22 }} disabled={pres.length === 1} onClick={() => setPres(pres.filter((_, j) => j !== i))} />
                  </div>
                  <div className="row wrap">
                    <span className="label">Consome:</span>
                    <div className="segmented">
                      <button type="button" className={p.mode === 'self' ? 'active' : ''} onClick={() => updatePres(i, { mode: 'self' })}>Deste produto</button>
                      <button type="button" className={p.mode === 'recipe' ? 'active' : ''} onClick={() => updatePres(i, { mode: 'recipe', components: p.components.length ? p.components : [{ productId: '', qty: null }] })}>Ficha técnica</button>
                    </div>
                    {p.mode === 'self' && <div style={{ width: 160 }}><DecimalInput value={p.selfQty} onChange={(v) => updatePres(i, { selfQty: v })} suffix={unit} /></div>}
                    <span className="grow" />
                    {cost !== null && p.priceCents ? <span className="small muted">Custo estimado {formatBRL(cost)} · margem {Math.round(((p.priceCents - cost) / p.priceCents) * 100)}%</span> : null}
                  </div>
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
                  <div className="row">
                    <label className="check small"><input type="checkbox" checked={p.menuVisible} onChange={(e) => updatePres(i, { menuVisible: e.target.checked })} /> No cardápio</label>
                    <label className="check small"><input type="checkbox" checked={p.active} onChange={(e) => updatePres(i, { active: e.target.checked })} /> Ativa</label>
                  </div>
                </div>
              </Card>
            );
          })}
          <Button icon={<Plus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setPres([...pres, { name: '', priceCents: null, menuVisible: true, active: true, mode: 'self', selfQty: f.measure === 'volume' ? 50 : 1, components: [] }])}>Adicionar apresentação</Button>
        </div>
      )}
    </Modal>
  );
}
