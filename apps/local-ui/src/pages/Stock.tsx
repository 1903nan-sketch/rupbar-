import {
  buyModeOf, countQty, describePack, describeStock, matchesProductCode, packsText, STOCK_MOVEMENT_TYPES, stockText, unitName, unitsText,
  type Measure, type Packaging, type StockMovementType,
} from '@rupbar/core';
import {
  AlertTriangle, Boxes, CircleCheck, CircleSlash, ClipboardCheck, FileSpreadsheet, History, PackagePlus, Plus, Search, SlidersHorizontal, Trash2, TriangleAlert, Truck,
  Undo2, type LucideIcon,
} from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CodeTag, CostEntry, CountEntry, EntrySentence, LevelChip, QtyEntry, saleRefOf, StockQty, totalCostOf } from '../components/stock-units';
import { Badge, Button, Card, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, useToast } from '../components/ui';
import { api, qs } from '../lib/api';
import { fmtDate, fmtDateTime, formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { ReasonModal } from '../components/OwnerActions';
import { defaultCostMode, emptyQty, entryPayload, qtyOf, type CostDraft, type QtyDraft } from '../lib/stock-units';
import '../styles/stock.css';
import { packagingOf, RemoveProductConfirm, type Product } from './Products';
import { QuickProductModal } from './QuickProduct';
import { StockImportModal } from './StockImport';

type Tab = 'saldos' | 'entradas' | 'movimentacoes' | 'inventario' | 'validades' | 'alertas' | 'fornecedores';

/** Colunas de embalagem que a API devolve junto com movimentações, lotes e alertas. */
interface PackagingRow {
  measure: Measure;
  package_qty: number;
  package_label: string | null;
  unit_label: string | null;
}
const rowPackaging = (r: PackagingRow): Packaging => ({ measure: r.measure, packageQty: r.package_qty, packageLabel: r.package_label, unitLabel: r.unit_label });

/** Atraso escalonado da animação de entrada das linhas (limitado para listas longas). */
const rowDelay = (i: number) => ({ '--i': Math.min(i, 14) }) as CSSProperties;

export function StockPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) ?? 'saldos';
  const { can } = useSession();
  const [create, setCreate] = useState(false);
  const [entry, setEntry] = useState<Product | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  const canImport = can('products.manage') && can('stock.entry') && can('stock.adjust');
  return (
    <div className="stack stock-page">
      <PageHeader title="Estoque" subtitle="Cadastre, reponha e acompanhe seus produtos. Tudo aparece nas duas formas: em unidades soltas e em embalagens fechadas." actions={<>
        {canImport && <Button className="hide-mobile" icon={<FileSpreadsheet size={16} />} onClick={() => setImporting(true)}>Importar planilha</Button>}
        {can('products.manage') && <Button icon={<Plus size={16} />} onClick={() => setCreate(true)}>Novo produto</Button>}
        {can('stock.entry') && <Button variant="primary" icon={<PackagePlus size={16} />} onClick={() => setEntry('new')}>Nova entrada</Button>}
      </>} />
      <Tabs value={tab} onChange={(v) => setParams({ aba: v })} options={[
        { value: 'saldos', label: 'Saldos' },
        { value: 'alertas', label: 'Alertas' },
        { value: 'entradas', label: 'Entradas', hidden: !can('stock.view') },
        { value: 'movimentacoes', label: 'Movimentações' },
        { value: 'inventario', label: 'Inventário' },
        { value: 'validades', label: 'Validades' },
        { value: 'fornecedores', label: 'Fornecedores' },
      ]} />
      {tab === 'saldos' && <Balances key={revision} onEntry={setEntry} onCreate={() => setCreate(true)} onImport={canImport ? () => setImporting(true) : undefined} />}
      {tab === 'alertas' && <Alerts />}
      {tab === 'entradas' && <Purchases key={revision} />}
      {tab === 'movimentacoes' && <Movements />}
      {tab === 'inventario' && <Inventory />}
      {tab === 'validades' && <Lots />}
      {tab === 'fornecedores' && <Suppliers />}
      {create && <QuickProductModal onClose={() => setCreate(false)} onSaved={refresh} />}
      {importing && <StockImportModal onClose={() => setImporting(false)} onDone={refresh} />}
      {entry && <PurchaseModal initialProduct={entry === 'new' ? undefined : entry} onClose={() => setEntry(null)} onDone={refresh} />}
    </div>
  );
}

function useTracked() {
  const r = useLoad(() => api.get<Product[]>('/api/products').then((ps) => ps.filter((p) => p.stockTracked)));
  useRealtime(['stock'], () => void r.reload());
  return r;
}

/** Nome, categoria, código (0007, 7, #0007) ou código de barras. */
function matchesSearch(p: Product, search: string): boolean {
  const q = search.trim().toLocaleLowerCase('pt-BR');
  if (!q) return true;
  return `${p.name} ${p.categoryName}`.toLocaleLowerCase('pt-BR').includes(q) || matchesProductCode(p.internalCode, q) || (!!p.barcode && p.barcode.includes(q));
}

/** "fardo de 12 latas", "garrafa de 1.000 ml" ou "unidade avulsa". */
const packDescription = (pk: Packaging) => (buyModeOf(pk) === 'single' ? `unidade avulsa (${unitName(pk, 1)})` : describePack(pk));

type LevelFilter = 'all' | 'ok' | 'low' | 'out';
const KPIS: { value: LevelFilter; label: string; hint: string; icon: LucideIcon; tone: string }[] = [
  { value: 'all', label: 'Todos', hint: 'com estoque controlado', icon: Boxes, tone: 'accent' },
  { value: 'ok', label: 'OK', hint: 'acima do mínimo', icon: CircleCheck, tone: 'green' },
  { value: 'low', label: 'Baixo', hint: 'no mínimo: hora de repor', icon: TriangleAlert, tone: 'orange' },
  { value: 'out', label: 'Zerado', hint: 'sem saldo ou negativo', icon: CircleSlash, tone: 'red' },
];
const inLevel = (p: Product, f: LevelFilter) => f === 'all' || (f === 'out' ? p.level === 'out' || p.level === 'negative' : p.level === f);

function Balances({ onEntry, onCreate, onImport }: { onEntry: (product: Product) => void; onCreate: () => void; onImport?: () => void }) {
  const { can } = useSession();
  const { data, error, reload } = useTracked();
  const [adjust, setAdjust] = useState<Product | null>(null);
  const [removing, setRemoving] = useState<Product | null>(null);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [cat, setCat] = useState('');
  const byCat = useLoad(() => api.get<{ category: string; products: number; below_min: number; value_cents: number | null }[]>('/api/reports/stock-by-category').catch(() => []));
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const counts: Record<LevelFilter, number> = { all: data.length, ok: 0, low: 0, out: 0 };
  for (const p of data) counts[p.level === 'negative' ? 'out' : p.level]++;
  const categories = [...new Set(data.map((p) => p.categoryName))];
  const stockValue = byCat.data?.some((c) => c.value_cents !== null) ? byCat.data.reduce((a, c) => a + (c.value_cents ?? 0), 0) : null;
  const filtered = data.filter((p) => matchesSearch(p, search) && inLevel(p, level) && (!cat || p.categoryName === cat));
  const filtering = !!search.trim() || level !== 'all' || !!cat;
  const clear = () => { setSearch(''); setLevel('all'); setCat(''); };
  return (
    <div className="stack">
      <div className="stock-kpis" role="group" aria-label="Situação do estoque">
        {KPIS.map((k) => {
          const Icon = k.icon;
          const active = level === k.value;
          return (
            <button key={k.value} type="button" className={`stock-kpi ${k.tone} ${active ? 'active' : ''}`} aria-pressed={active}
              onClick={() => setLevel(active ? 'all' : k.value)}>
              <span className="stock-kpi-icon" aria-hidden="true"><Icon size={18} /></span>
              <span className="stock-kpi-label">{k.label}</span>
              <span className="stock-kpi-value">{counts[k.value]}</span>
              <span className="stock-kpi-hint">{k.hint}</span>
            </button>
          );
        })}
      </div>
      <div className="filter-bar stock-filters">
        <div className="input-group grow"><Search size={16} className="prefix" /><Input aria-label="Buscar no estoque" placeholder="Buscar por nome, código (ex.: 0007) ou código de barras…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <Select aria-label="Filtrar por categoria" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Todas as categorias</option>
          {categories.map((c) => <option key={c} value={c}>{c} ({data.filter((p) => p.categoryName === c).length})</option>)}
        </Select>
        {stockValue !== null && <span className="stock-value small muted">Valor em estoque <strong>{formatBRL(stockValue)}</strong></span>}
        {filtering && <Button size="small" variant="plain" onClick={clear}>Limpar filtros</Button>}
      </div>
      <Card flush className="stock-table-card">
        {filtered.length === 0 ? (
          <Empty icon={<PackagePlus size={32} />} title={data.length ? 'Nenhum produto neste filtro' : 'Vamos cadastrar seu estoque?'}>
            {data.length
              ? <div className="stack stock-empty-actions"><span>Tente outro nome, código ou situação.</span><Button size="small" onClick={clear}>Limpar filtros</Button></div>
              : <div className="stack stock-empty-actions"><span>Cadastre o produto dizendo como você compra (unidade, fardo, garrafa ou pacote). O saldo inicial entra na mesma tela.</span>{can('products.manage') && <Button variant="primary" onClick={onCreate}>Cadastrar primeiro produto</Button>}{onImport && <Button icon={<FileSpreadsheet size={16} />} onClick={onImport}>Importar planilha com tudo</Button>}</div>}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table stock-table">
              <thead><tr><th>Produto</th><th className="right">Saldo</th><th className="right">Mínimo</th><th>Situação</th><th><span className="sr-only">Ações</span></th></tr></thead>
              <tbody>
                {filtered.map((p, i) => {
                  const pk = packagingOf(p);
                  const fill = p.minStock > 0 ? Math.max(0, Math.min(1, p.stockQty / (p.minStock * 2))) : null;
                  return (
                    <tr key={p.id} className={`stock-row level-${p.level}`} style={rowDelay(i)}>
                      <td data-label="Produto">
                        <div className="row product-name-line"><CodeTag code={p.internalCode} /><span className="strong">{p.name}</span></div>
                        <div className="tiny muted">{p.categoryName} · {packDescription(pk)}</div>
                      </td>
                      <td data-label="Saldo" className="right">
                        <StockQty qty={p.stockQty} packaging={pk} />
                        {fill !== null && <span className={`stock-meter ${p.level}`} aria-hidden="true"><span style={{ width: `${Math.round(fill * 100)}%` }} /></span>}
                      </td>
                      <td data-label="Mínimo" className="right small muted">{p.minStock ? stockText(p.minStock, pk) : '—'}</td>
                      <td data-label="Situação"><LevelChip level={p.level} /></td>
                      <td className="stock-actions"><div className="row end">
                        {can('stock.entry') && <Button size="small" icon={<PackagePlus size={14} />} onClick={() => onEntry(p)}>Entrada</Button>}
                        {can('stock.adjust') && <Button size="small" variant="plain" icon={<SlidersHorizontal size={14} />} onClick={() => setAdjust(p)}>Ajustar</Button>}
                        {can('products.manage') && <Button size="small" variant="plain" icon={<Trash2 size={14} />} aria-label={`Excluir ${p.name}`} title="Excluir produto" onClick={() => setRemoving(p)} />}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adjust && <AdjustModal product={adjust} onClose={() => setAdjust(null)} onDone={reload} />}
      {removing && <RemoveProductConfirm product={removing} onClose={() => setRemoving(null)} onDone={() => void reload()} />}
    </div>
  );
}

/** Saldo atual decomposto para pré-preencher a contagem: fechadas + soltas. */
function splitCount(qty: number, pk: Packaging): { closed: number | null; loose: number | null } {
  const q = Math.max(0, qty);
  if (buyModeOf(pk) === 'single') return { closed: null, loose: q / 1000 };
  const closed = Math.floor(q / pk.packageQty);
  return { closed, loose: (q - closed * pk.packageQty) / 1000 };
}

function DiffText({ diff, pk }: { diff: number; pk: Packaging }) {
  if (diff === 0) return <span className="muted">sem diferença</span>;
  return <span className={diff < 0 ? 'danger-text' : 'warning-text'}>{diff > 0 ? '+' : '−'}{unitsText(Math.abs(diff), pk)}</span>;
}

function AdjustModal({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const pk = packagingOf(product);
  const [count, setCount] = useState(() => splitCount(product.stockQty, pk));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const counted = countQty(count.closed, count.loose, pk);
  return (
    <Modal title={`Ajustar estoque — ${product.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={async () => {
      if (reason.trim().length < 3) return toast.error('Informe o motivo do ajuste.');
      setBusy(true);
      try { await api.post('/api/stock/adjustments', { productId: product.id, countedQty: counted, reason }); toast.success('Ajuste registrado'); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Registrar ajuste</Button></>}>
      <div className="stack">
        <p className="muted">Saldo no sistema: <strong>{stockText(product.stockQty, pk)}</strong>. Conte o que existe de verdade e informe abaixo{buyModeOf(pk) === 'single' ? '' : ' — as fechadas e as soltas'}. Para perdas (quebra, vencimento), use Perdas.</p>
        <CountEntry packaging={pk} closed={count.closed} loose={count.loose} onChange={(closed, loose) => setCount({ closed, loose })} autoFocus />
        <div className="stock-entry-summary compact">Saldo correto: <strong>{stockText(counted, pk)}</strong> · <DiffText diff={counted - product.stockQty} pk={pk} /></div>
        <Field label="Motivo *"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: correção de lançamento" /></Field>
      </div>
    </Modal>
  );
}

interface AlertRow extends PackagingRow {
  id: string; product_id: string; name: string; internal_code: string | null; stock_qty: number; min_stock: number; level: string;
  supplier_name: string | null; supplier_phone: string | null; suggestion: { qty: number; packages: number };
}

function Alerts() {
  const { data, error, reload } = useLoad(() => api.get<AlertRow[]>('/api/stock/alerts'));
  useRealtime(['stock'], () => void reload());
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.length) return <Card><Empty icon={<CircleCheck size={36} />} title="Nenhum alerta">Todos os produtos estão acima do estoque mínimo.</Empty></Card>;
  return (
    <Card flush>
      <div className="list">
        {data.map((a, i) => {
          const pk = rowPackaging(a);
          const sug = a.suggestion.qty;
          return (
            <div key={a.id} className="list-item stock-row" style={rowDelay(i)}>
              <AlertTriangle size={18} className={a.level === 'low' ? 'warning-text' : 'danger-text'} />
              <div className="grow">
                <div className="row product-name-line"><CodeTag code={a.internal_code} /><span className="strong">{a.name}</span></div>
                <div className="small muted">Saldo {stockText(a.stock_qty, pk)} · mínimo {stockText(a.min_stock, pk)}{a.supplier_name && ` · ${a.supplier_name}`}</div>
              </div>
              {sug > 0 && <Badge color="accent">Repor {buyModeOf(pk) === 'single' ? unitsText(sug, pk) : `${packsText(sug, pk)} (${unitsText(sug, pk)})`}</Badge>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

interface PurchaseItemRow extends PackagingRow { product_name: string; qty: number; total_cost_cents: number; expires_on: string | null }

function Purchases() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const { data, error, reload } = useLoad(() => api.get<{ id: string; purchased_at: string; supplier_name: string | null; invoice_number: string | null; total_cents: number; created_by_name: string; status?: string; cancel_reason?: string | null; items: PurchaseItemRow[] }[]>('/api/stock/purchases'));
  const [cancel, setCancel] = useState<{ id: string; label: string } | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="stack">
      {can('stock.entry') && <Button variant="primary" icon={<PackagePlus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Nova entrada de mercadorias</Button>}
      {!data ? <Loading /> : data.length === 0 ? <Card><Empty icon={<Truck size={36} />} title="Nenhuma entrada registrada">Quando a mercadoria chegar, registre aqui: o saldo e o custo médio se atualizam sozinhos.</Empty></Card> : (
        <Card flush>
          <div className="list">
            {data.map((p, i) => (
              <div key={p.id} className={`list-item stock-row ${p.status === 'canceled' ? 'voided' : ''}`} style={{ alignItems: 'flex-start', ...rowDelay(i) }}>
                <div className="grow">
                  <div className="strong">{p.supplier_name ?? 'Sem fornecedor'}{p.invoice_number && <span className="muted"> · NF {p.invoice_number}</span>}</div>
                  {p.status === 'canceled' && <div className="tiny danger-text">Entrada excluída: {p.cancel_reason}</div>}
                  <div className="small muted">{fmtDateTime(p.purchased_at)} · {p.created_by_name}</div>
                  <div className="small" style={{ marginTop: 4 }}>{p.items.map((it) => `${it.product_name}: ${stockText(it.qty, rowPackaging(it))}`).join(' · ')}</div>
                </div>
                <span className="num strong">{formatBRL(p.total_cents)}</span>
                {can('admin.override') && p.status !== 'canceled' && (
                  <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label="Excluir entrada" title="Excluir entrada (conta mestre)"
                    onClick={() => setCancel({ id: p.id, label: `${p.supplier_name ?? 'Entrada'}${p.invoice_number ? ` · NF ${p.invoice_number}` : ''}` })} />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
      {open && <PurchaseModal onClose={() => setOpen(false)} onDone={reload} />}
      {cancel && (
        <ReasonModal title="Excluir entrada de mercadorias" danger confirmLabel="Excluir entrada" description={<>{cancel.label}. Tudo o que esta entrada somou sai do estoque.</>}
          onClose={() => setCancel(null)} onConfirm={async (reason) => { await api.post(`/api/admin/purchases/${cancel.id}/cancel`, { reason }); void reload(); }} />
      )}
    </div>
  );
}

interface PurchaseLine {
  key: number;
  productId: string;
  qty: QtyDraft;
  cost: CostDraft;
  /** Embalagem diferente nesta compra (unidades, ml ou g por embalagem). */
  customSize: number | null;
  showSize: boolean;
  expiresOn: string;
}

let lineKey = 0;
function newLine(p?: Product): PurchaseLine {
  const pk = p ? packagingOf(p) : null;
  return {
    key: ++lineKey, productId: p?.id ?? '', qty: pk ? emptyQty(pk) : { amount: null, mode: 'pack' },
    cost: { cents: null, mode: pk ? defaultCostMode(pk) : 'pack' }, customSize: null, showSize: false, expiresOn: '',
  };
}

export function PurchaseModal({ initialProduct, onClose, onDone }: { initialProduct?: Product; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const products = useTracked();
  const suppliers = useLoad(() => api.get<{ id: string; name: string }[]>('/api/suppliers'));
  const [supplierId, setSupplierId] = useState('');
  const [invoice, setInvoice] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<PurchaseLine[]>(() => [newLine(initialProduct)]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const availableProducts = products.data ?? (initialProduct ? [initialProduct] : []);
  const byId = (id: string) => availableProducts.find((p) => p.id === id);

  /** Produto, embalagem efetiva desta compra, quantidade (milli) e total pago. */
  const info = (l: PurchaseLine) => {
    const p = byId(l.productId);
    if (!p) return null;
    const base = packagingOf(p);
    const pk = l.customSize && l.customSize > 0 ? { ...base, packageQty: Math.round(l.customSize * 1000) } : base;
    const qty = qtyOf(l.qty, pk);
    return { p, pk, qty, total: totalCostOf(l.cost, qty, pk) };
  };
  const total = lines.reduce((a, l) => a + (info(l)?.total ?? 0), 0);

  const submit = async () => {
    if (busy) return;
    const items = [];
    for (const [i, l] of lines.entries()) {
      const it = info(l);
      if (!it) return toast.error(`Selecione o produto do item ${i + 1}.`);
      if (!l.qty.amount || l.qty.amount <= 0 || it.qty <= 0 || (l.qty.mode === 'pack' && l.qty.amount > 100_000)) return toast.error(`Confira a quantidade que chegou do item ${i + 1}.`);
      if (it.total === null || it.total < 0) return toast.error(`Informe quanto você pagou no item ${i + 1}.`);
      items.push({ productId: it.p.id, ...entryPayload(l.qty, it.pk), packageQty: it.pk.packageQty, totalCostCents: it.total, expiresOn: l.expiresOn || null });
    }
    setBusy(true);
    try {
      let attachmentId: string | null = null;
      if (file) attachmentId = (await api.upload<{ id: string }>('/api/attachments?kind=invoice', file)).id;
      await api.post('/api/stock/purchases', { supplierId: supplierId || null, invoiceNumber: invoice || null, attachmentId, items });
      toast.success('Entrada registrada; estoque e custo médio atualizados');
      onDone();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const setLine = (i: number, patch: Partial<PurchaseLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const q = search.trim().toLocaleLowerCase('pt-BR');

  return (
    <Modal title="Entrada de mercadorias" wide onClose={onClose} footer={<><span className="grow strong num">Total {formatBRL(total)}</span><Button disabled={busy} onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!products.data?.length} onClick={submit}>Registrar entrada</Button></>}>
      <div className="stack">
        {products.error && <ErrorBox error={products.error} onRetry={products.reload} />}
        {products.data?.length === 0 && <div className="banner warning">Cadastre um produto pelo botão “Novo produto” no estoque antes de registrar uma entrada.</div>}
        <p className="small muted">Escolha o produto, diga se está contando <strong>embalagens fechadas</strong> (fardos, garrafas) ou <strong>unidades soltas</strong> (latas, ml) e quanto pagou. A frase abaixo de cada item confere a conta antes de salvar.</p>
        <div className="input-group"><Search size={16} className="prefix" /><Input aria-label="Buscar produto para entrada" placeholder="Filtrar produtos por nome ou código…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <details className="optional-fields"><summary>Fornecedor, nota fiscal e comprovante (opcional)</summary><div className="grid-3">
          <Field label="Fornecedor"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">—</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Nota fiscal"><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
          <Field label="Arquivo da nota (opcional)"><input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        </div></details>
        {lines.map((l, i) => {
          const it = info(l);
          const buy = it ? buyModeOf(it.pk) : null;
          const baseSize = it ? it.p.packageQty / 1000 : null;
          return (
            <Card key={l.key} tight className="purchase-line">
              <div className="row between"><strong className="small">Item {i + 1}</strong><Button variant="plain" icon={<Trash2 size={15} />} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Remover item ${i + 1}`} /></div>
              <div className="purchase-line-body">
                <Field label="Produto" className="span-all">
                  <Select value={l.productId} onChange={(e) => {
                    const np = byId(e.target.value);
                    setLine(i, { productId: e.target.value, customSize: null, showSize: false, ...(np ? { qty: { ...emptyQty(packagingOf(np)), amount: l.qty.amount }, cost: { ...l.cost, mode: defaultCostMode(packagingOf(np)) } } : {}) });
                  }}>
                    <option value="">Selecione…</option>
                    {availableProducts.filter((x) => x.id === l.productId || !q || x.name.toLocaleLowerCase('pt-BR').includes(q) || matchesProductCode(x.internalCode, q) || x.barcode === search.trim())
                      .map((x) => <option key={x.id} value={x.id}>{x.internalCode ? `${x.internalCode} · ` : ''}{x.name}</option>)}
                  </Select>
                </Field>
                {it ? <>
                  <div className="purchase-pack span-all">
                    <span>Compra em: <strong>{packDescription(it.pk)}</strong></span>
                    {buy !== 'single' && <button type="button" className="link-button" onClick={() => setLine(i, { showSize: !l.showSize, customSize: l.showSize ? null : baseSize })}>{l.showSize ? 'Usar o tamanho do cadastro' : 'Embalagem diferente desta vez?'}</button>}
                  </div>
                  {l.showSize && (
                    <Field className="span-all" label={buy === 'pack' ? `Quantas ${unitName(it.pk, 2)} vieram em cada ${it.pk.packageLabel ?? 'embalagem'}?` : buy === 'bottle' ? 'Tamanho desta garrafa (ml)' : 'Peso deste pacote (g)'} hint={`O cadastro continua com ${describePack(packagingOf(it.p))}.`}>
                      <DecimalInput value={l.customSize} onChange={(v) => setLine(i, { customSize: v })} />
                    </Field>
                  )}
                  <QtyEntry label="Quantidade que chegou" packaging={it.pk} value={l.qty} onChange={(v) => setLine(i, { qty: v })} />
                  <CostEntry label="Quanto você pagou?" packaging={it.pk} value={l.cost} onChange={(v) => setLine(i, { cost: v })} hint="Escolha se o valor é por embalagem, por unidade ou o total do item." />
                  <Field label="Validade (opcional)"><Input type="date" value={l.expiresOn} onChange={(e) => setLine(i, { expiresOn: e.target.value })} /></Field>
                  <div className="span-all"><EntrySentence packaging={it.pk} qty={l.qty} cost={l.cost} doseQty={it.p.doseQty} sale={saleRefOf(it.p.presentations, it.pk)} /></div>
                </> : <p className="small muted span-all">Escolha o produto para informar quantidade e custo.</p>}
              </div>
            </Card>
          );
        })}
        <Button icon={<Plus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setLines([...lines, newLine()])}>Adicionar item</Button>
      </div>
    </Modal>
  );
}

interface MovementRow extends PackagingRow {
  id: string; product_name: string; type: StockMovementType; delta: number; balance_after: number; reason: string | null; user_name: string | null; created_at: string; cost_cents: number;
}

function Movements() {
  const [type, setType] = useState('');
  const products = useTracked();
  const [productId, setProductId] = useState('');
  const { data, error, reload } = useLoad(() => api.get<MovementRow[]>(`/api/stock/movements${qs({ type, productId, limit: 300 })}`), [type, productId]);
  const { can } = useSession();
  const master = can('admin.override');
  const [undo, setUndo] = useState<MovementRow | null>(null);
  return (
    <div className="stack">
      <div className="filter-bar stock-filters">
        <Select aria-label="Filtrar por produto" value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Todos os produtos</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.internalCode ? `${p.internalCode} · ` : ''}{p.name}</option>)}</Select>
        <Select aria-label="Tipo de movimentação" value={type} onChange={(e) => setType(e.target.value)}><option value="">Todos os tipos</option>{Object.entries(STOCK_MOVEMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? <Loading /> : data.length === 0 ? <Card><Empty icon={<History size={36} />} title="Nenhuma movimentação">Entradas, vendas, perdas e ajustes aparecem aqui, com quem fez e quando.</Empty></Card> : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Data</th><th>Produto</th><th>Tipo</th><th className="right">Quantidade</th><th className="right">Saldo</th><th>Responsável / motivo</th>{master && <th />}</tr></thead>
              <tbody>
                {data.map((m, i) => {
                  const pk = rowPackaging(m);
                  const amount = describeStock(Math.abs(m.delta), pk);
                  return (
                    <tr key={m.id} className="stock-row" style={rowDelay(i)}>
                      <td className="small nowrap">{fmtDateTime(m.created_at)}</td>
                      <td>{m.product_name}</td>
                      <td><Badge color={m.delta > 0 ? 'green' : m.type === 'loss' ? 'red' : undefined}>{STOCK_MOVEMENT_TYPES[m.type]}</Badge></td>
                      <td className={`right num ${m.delta > 0 ? 'success-text' : ''}`}>
                        <span className="stock-qty"><span className="stock-qty-main">{m.delta > 0 ? '+' : '−'}{amount.main}</span>{amount.detail && <span className="stock-qty-detail">({amount.detail})</span>}</span>
                      </td>
                      <td className="right num muted small">{stockText(m.balance_after, pk)}</td>
                      <td className="small muted">{m.user_name ?? 'Sistema'}{m.reason && ` · ${m.reason}`}</td>
                      {master && (
                        <td className="right">
                          {['adjustment', 'inventory', 'hookah'].includes(m.type) && <Button size="small" variant="plain" icon={<Undo2 size={15} />} aria-label="Desfazer" title="Desfazer (conta mestre)" onClick={() => setUndo(m)} />}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {undo && (
        <ReasonModal title="Desfazer movimentação" confirmLabel="Desfazer" description={<>{STOCK_MOVEMENT_TYPES[undo.type]} de {undo.product_name}. Lança a movimentação inversa (fica no histórico).</>}
          onClose={() => setUndo(null)} onConfirm={async (reason) => { await api.post(`/api/admin/stock-movements/${undo.id}/reverse`, { reason }); void reload(); }} />
      )}
    </div>
  );
}

function Inventory() {
  const toast = useToast();
  const { can } = useSession();
  const products = useTracked();
  const history = useLoad(() => api.get<{ id: string; created_at: string; created_by_name: string; item_count: number; divergence_count: number; shortage_cost_cents: number }[]>('/api/stock/inventories'));
  const [counting, setCounting] = useState(false);
  const [counts, setCounts] = useState<Record<string, { closed: number | null; loose: number | null }>>({});
  const [filter, setFilter] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ items: { name: string; expected: number; counted: number; diff: number; costCents: number; productId: string }[] } | null>(null);

  const submit = async () => {
    const items = Object.entries(counts)
      .filter(([, c]) => c.closed !== null || c.loose !== null)
      .map(([productId, c]) => {
        const p = products.data!.find((x) => x.id === productId)!;
        return { productId, countedQty: countQty(c.closed, c.loose, packagingOf(p)) };
      });
    if (!items.length) return toast.error('Informe ao menos uma contagem.');
    setBusy(true);
    try {
      setResult(await api.post('/api/stock/inventories', { items, notes: notes || null }));
      setCounting(false);
      setCounts({});
      void history.reload();
      void products.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (!products.data) return <Loading />;
  const visible = products.data.filter((p) => matchesSearch(p, filter));
  return (
    <div className="stack">
      {!counting ? (
        <>
          {can('stock.adjust') && <Button variant="primary" icon={<ClipboardCheck size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setCounting(true)}>Iniciar contagem</Button>}
          {result && (
            <Card title="Resultado do inventário">
              <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th className="right">Sistema</th><th className="right">Contado</th><th className="right">Divergência</th></tr></thead><tbody>
                {result.items.map((i) => {
                  const p = products.data!.find((x) => x.id === i.productId);
                  const pk: Packaging = p ? packagingOf(p) : { measure: 'unit', packageQty: 1000 };
                  return <tr key={i.productId}><td>{i.name}</td><td className="right num">{stockText(i.expected, pk)}</td><td className="right num">{stockText(i.counted, pk)}</td><td className="right num"><DiffText diff={i.diff} pk={pk} /></td></tr>;
                })}
              </tbody></table></div>
            </Card>
          )}
          <Card title="Inventários anteriores" flush>
            <div className="list">
              {history.data?.length === 0 && <div className="list-item muted">Nenhum inventário ainda. Faça uma contagem para conferir o sistema com a prateleira.</div>}
              {history.data?.map((h) => (
                <div key={h.id} className="list-item">
                  <div className="grow"><div>{fmtDateTime(h.created_at)}</div><div className="tiny muted">{h.created_by_name} · {h.item_count} produtos</div></div>
                  {h.divergence_count > 0 ? <Badge color="orange">{h.divergence_count} divergência(s)</Badge> : <Badge color="green">Sem divergências</Badge>}
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : (
        <Card title="Contagem" actions={<><Button onClick={() => setCounting(false)}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit}>Concluir inventário</Button></>}>
          <p className="small muted" style={{ marginBottom: 12 }}>Para cada produto, informe as embalagens <strong>fechadas</strong> e o que está <strong>solto ou aberto</strong> (latas soltas, ml da garrafa aberta). Deixe em branco o que não foi contado. As divergências viram ajustes registrados.</p>
          <div className="input-group" style={{ marginBottom: 12 }}><Search size={16} className="prefix" /><Input aria-label="Filtrar produtos da contagem" placeholder="Filtrar por nome ou código…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <div className="table-wrap">
            <table className="table stock-count-table">
              <thead><tr><th>Produto</th><th className="right">Sistema</th><th>Contagem</th><th className="right">Total contado</th></tr></thead>
              <tbody>
                {visible.map((p) => {
                  const pk = packagingOf(p);
                  const c = counts[p.id] ?? { closed: null, loose: null };
                  const has = c.closed !== null || c.loose !== null;
                  return (
                    <tr key={p.id}>
                      <td><div className="row product-name-line"><CodeTag code={p.internalCode} /><span className="strong">{p.name}</span></div><div className="tiny muted">{packDescription(pk)}</div></td>
                      <td className="right"><StockQty qty={p.stockQty} packaging={pk} /></td>
                      <td><CountEntry packaging={pk} closed={c.closed} loose={c.loose} context={p.name} onChange={(closed, loose) => setCounts({ ...counts, [p.id]: { closed, loose } })} /></td>
                      <td className="right">{has ? <><StockQty qty={countQty(c.closed, c.loose, pk)} packaging={pk} /><div className="tiny"><DiffText diff={countQty(c.closed, c.loose, pk) - p.stockQty} pk={pk} /></div></> : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Field label="Observações"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </Card>
      )}
    </div>
  );
}

interface LotRow extends PackagingRow { id: string; product_name: string; lot_code: string | null; expires_on: string; qty_remaining: number; expired: boolean }

function Lots() {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useLoad(() => api.get<LotRow[]>(`/api/stock/lots?days=${days}`), [days]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <Select aria-label="Período de vencimento" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 240 }}>
        <option value={7}>Vencendo em 7 dias</option>
        <option value={30}>Vencendo em 30 dias</option>
        <option value={90}>Vencendo em 90 dias</option>
      </Select>
      {!data ? <Loading /> : data.length === 0 ? <Card><Empty icon={<CircleCheck size={36} />} title="Nenhum lote vencendo no período">Informe a validade nas entradas para acompanhar aqui.</Empty></Card> : (
        <Card flush>
          <div className="list">
            {data.map((l, i) => (
              <div key={l.id} className="list-item stock-row" style={rowDelay(i)}>
                <div className="grow"><div className="strong">{l.product_name}</div><div className="small muted">{l.lot_code ? `Lote ${l.lot_code} · ` : ''}restante {stockText(l.qty_remaining, rowPackaging(l))}</div></div>
                {l.expired ? <Badge color="red">Vencido em {fmtDate(l.expires_on + 'T12:00:00')}</Badge> : <Badge color="orange">Vence em {fmtDate(l.expires_on + 'T12:00:00')}</Badge>}
              </div>
            ))}
          </div>
        </Card>
      )}
      <p className="small muted">Produtos vencidos devem ser baixados em Perdas (motivo “Vencimento”) pelo proprietário.</p>
    </div>
  );
}

function Suppliers() {
  const toast = useToast();
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api.get<{ id: string; name: string; cnpj: string | null; phone: string | null; email: string | null; contact_name: string | null; notes: string | null; active: number }[]>('/api/suppliers'));
  const [edit, setEdit] = useState<{ id?: string; name: string; cnpj: string; phone: string; email: string; contactName: string; notes: string } | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="stack">
      {can('suppliers.manage') && <Button variant="primary" icon={<Plus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setEdit({ name: '', cnpj: '', phone: '', email: '', contactName: '', notes: '' })}>Novo fornecedor</Button>}
      {!data ? <Loading /> : (
        <Card flush>
          <div className="list">
            {data.length === 0 && <div className="list-item muted">Nenhum fornecedor cadastrado.</div>}
            {data.map((s) => (
              <div key={s.id} className="list-item clickable" onClick={() => can('suppliers.manage') && setEdit({ id: s.id, name: s.name, cnpj: s.cnpj ?? '', phone: s.phone ?? '', email: s.email ?? '', contactName: s.contact_name ?? '', notes: s.notes ?? '' })}>
                <div className="grow"><div className="strong">{s.name}</div><div className="small muted">{[s.contact_name, s.phone, s.email].filter(Boolean).join(' · ')}</div></div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {edit && (
        <Modal title={edit.id ? 'Editar fornecedor' : 'Novo fornecedor'} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancelar</Button><Button variant="primary" onClick={async () => {
          try {
            const body = { name: edit.name, cnpj: edit.cnpj || null, phone: edit.phone || null, email: edit.email || null, contactName: edit.contactName || null, notes: edit.notes || null };
            if (edit.id) await api.put(`/api/suppliers/${edit.id}`, body);
            else await api.post('/api/suppliers', body);
            toast.success('Fornecedor salvo');
            setEdit(null);
            void reload();
          } catch (e) { toast.error(e); }
        }}>Salvar</Button></>}>
          <div className="stack">
            <Field label="Nome *"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <div className="grid-2">
              <Field label="CNPJ"><Input value={edit.cnpj} onChange={(e) => setEdit({ ...edit, cnpj: e.target.value })} /></Field>
              <Field label="Contato"><Input value={edit.contactName} onChange={(e) => setEdit({ ...edit, contactName: e.target.value })} /></Field>
              <Field label="Telefone"><Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
              <Field label="E-mail"><Input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            </div>
            <Field label="Observações"><Textarea value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
