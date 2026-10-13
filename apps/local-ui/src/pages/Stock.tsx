import { BASE_UNIT, formatQty, STOCK_MOVEMENT_TYPES, type Measure, type StockMovementType } from '@rupbar/core';
import { AlertTriangle, ClipboardCheck, PackagePlus, Plus, Search, SlidersHorizontal, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, DecimalInput, Empty, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Tabs, Textarea, useToast } from '../components/ui';
import { api, qs } from '../lib/api';
import { fmtDate, fmtDateTime, formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { LEVEL_BADGE, type Product } from './Products';
import { QuickProductModal } from './QuickProduct';

type Tab = 'saldos' | 'entradas' | 'movimentacoes' | 'inventario' | 'validades' | 'alertas' | 'fornecedores';

export function StockPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) ?? 'saldos';
  const { can } = useSession();
  const [create, setCreate] = useState(false);
  const [entry, setEntry] = useState<Product | 'new' | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  return (
    <div className="stack">
      <PageHeader title="Estoque" subtitle="Cadastre, reponha e acompanhe seus produtos em um só lugar." actions={<>
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
      {tab === 'saldos' && <Balances key={revision} onEntry={setEntry} onCreate={() => setCreate(true)} />}
      {tab === 'alertas' && <Alerts />}
      {tab === 'entradas' && <Purchases key={revision} />}
      {tab === 'movimentacoes' && <Movements />}
      {tab === 'inventario' && <Inventory />}
      {tab === 'validades' && <Lots />}
      {tab === 'fornecedores' && <Suppliers />}
      {create && <QuickProductModal onClose={() => setCreate(false)} onSaved={refresh} />}
      {entry && <PurchaseModal initialProduct={entry === 'new' ? undefined : entry} onClose={() => setEntry(null)} onDone={refresh} />}
    </div>
  );
}

function useTracked() {
  const r = useLoad(() => api.get<Product[]>('/api/products').then((ps) => ps.filter((p) => p.stockTracked)));
  useRealtime(['stock'], () => void r.reload());
  return r;
}

function Balances({ onEntry, onCreate }: { onEntry: (product: Product) => void; onCreate: () => void }) {
  const { can } = useSession();
  const { data, error, reload } = useTracked();
  const [adjust, setAdjust] = useState<Product | null>(null);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('');
  const byCat = useLoad(() => api.get<{ category: string; products: number; below_min: number; value_cents: number | null }[]>('/api/reports/stock-by-category'));
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const filtered = data.filter((p) => `${p.name} ${p.categoryName} ${p.barcode ?? ''} ${p.internalCode ?? ''}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')) && (!level || (level === 'alert' ? p.level !== 'ok' : p.level === level)));
  return (
    <div className="stack">
      <div className="grid-3 stock-overview">
        <Stat label="Produtos cadastrados" value={data.length} hint="Com controle de saldo ativo" />
        <Stat label="Precisam de reposição" value={data.filter((p) => p.level !== 'ok').length} hint="Abaixo do mínimo ou sem saldo" />
        <Stat label="Com saldo disponível" value={data.filter((p) => p.stockQty > 0).length} hint="Prontos para a operação" />
      </div>
      {byCat.data && (
        <div className="scroll-x">
          {byCat.data.map((c) => (
            <div key={c.category} className="card tight" style={{ minWidth: 170 }}>
              <div className="small muted">{c.category}</div>
              <div className="strong">{c.products} {c.products === 1 ? 'item' : 'itens'}{c.below_min > 0 && <span className="warning-text"> · {c.below_min} baixo</span>}</div>
              {c.value_cents !== null && <div className="small num">{formatBRL(c.value_cents)}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="filter-bar"><div className="input-group grow"><Search size={16} className="prefix" /><Input aria-label="Buscar no estoque" placeholder="Buscar produto, categoria ou código…" value={search} onChange={(e) => setSearch(e.target.value)} /></div><Select aria-label="Situação do estoque" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Todas as situações</option><option value="alert">Precisam de reposição</option><option value="ok">Saldo OK</option><option value="out">Sem saldo</option><option value="low">Estoque baixo</option><option value="negative">Saldo negativo</option></Select></div>
      <Card flush>
        {filtered.length === 0 ? <Empty icon={<PackagePlus size={32} />} title={data.length ? 'Nenhum produto neste filtro' : 'Vamos cadastrar seu estoque?'}>{data.length ? 'Tente outro nome ou situação.' : <div className="stack"><span>Cadastre o produto e informe o saldo inicial na mesma tela.</span>{can('products.manage') && <Button variant="primary" onClick={onCreate}>Cadastrar primeiro produto</Button>}</div>}</Empty> :
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Produto</th><th className="right">Saldo</th><th className="right">Embalagens</th><th className="right">Mínimo</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td><div className="strong">{p.name}</div><div className="tiny muted">{p.categoryName}</div></td>
                  <td className="right num strong">{formatQty(p.stockQty, p.measure)}</td>
                  <td className="right small muted">{p.packages && p.packageQty > 1000 ? `${p.packages.closed} fechada(s)${p.packages.hasOpen ? ` + ${formatQty(p.packages.openRemaining, p.measure)}` : ''}` : '—'}</td>
                  <td className="right num muted">{p.minStock ? formatQty(p.minStock, p.measure) : '—'}</td>
                  <td>{LEVEL_BADGE[p.level]}</td>
                  <td><div className="row end">{can('stock.entry') && <Button size="small" icon={<PackagePlus size={14} />} onClick={() => onEntry(p)}>Entrada</Button>}{can('stock.adjust') && <Button size="small" variant="plain" icon={<SlidersHorizontal size={14} />} onClick={() => setAdjust(p)}>Ajustar</Button>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </Card>
      {adjust && <AdjustModal product={adjust} onClose={() => setAdjust(null)} onDone={reload} />}
    </div>
  );
}

function AdjustModal({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const unit = BASE_UNIT[product.measure];
  const [counted, setCounted] = useState<number | null>(product.stockQty / 1000);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Ajustar estoque — ${product.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={async () => {
      setBusy(true);
      try { await api.post('/api/stock/adjustments', { productId: product.id, countedQty: Math.round((counted ?? 0) * 1000), reason }); toast.success('Ajuste registrado'); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Registrar ajuste</Button></>}>
      <div className="stack">
        <p className="muted">Saldo no sistema: <strong>{formatQty(product.stockQty, product.measure)}</strong>. O ajuste fica registrado com seu nome e o motivo. Para perdas (quebra, vencimento), use Perdas.</p>
        <Field label={`Saldo correto (${unit})`}><DecimalInput autoFocus value={counted} onChange={setCounted} suffix={unit} /></Field>
        <Field label="Motivo *"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: correção de lançamento" /></Field>
      </div>
    </Modal>
  );
}

function Alerts() {
  const { data, error, reload } = useLoad(() => api.get<{ id: string; product_id: string; name: string; measure: Measure; stock_qty: number; min_stock: number; level: string; supplier_name: string | null; supplier_phone: string | null; package_label: string | null; suggestion: { qty: number; packages: number } }[]>('/api/stock/alerts'));
  useRealtime(['stock'], () => void reload());
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.length) return <Card><Empty icon={<AlertTriangle size={36} />} title="Nenhum alerta">Todos os produtos estão acima do estoque mínimo.</Empty></Card>;
  return (
    <Card flush>
      <div className="list">
        {data.map((a) => (
          <div key={a.id} className="list-item">
            <AlertTriangle size={18} className={a.level === 'low' ? 'warning-text' : 'danger-text'} />
            <div className="grow">
              <div className="strong">{a.name}</div>
              <div className="small muted">Saldo {formatQty(a.stock_qty, a.measure)} · mínimo {formatQty(a.min_stock, a.measure)}{a.supplier_name && ` · ${a.supplier_name}`}</div>
            </div>
            {a.suggestion.packages > 0 && <Badge color="accent">Repor {a.suggestion.packages} {a.package_label ?? 'emb.'} ({formatQty(a.suggestion.qty, a.measure)})</Badge>}
          </div>
        ))}
      </div>
    </Card>
  );
}

interface PurchaseLine {
  productId: string;
  packages: number | null;
  packageQty: number | null;
  totalCostCents: number | null;
  expiresOn: string;
}

function Purchases() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const { data, error, reload } = useLoad(() => api.get<{ id: string; purchased_at: string; supplier_name: string | null; invoice_number: string | null; total_cents: number; created_by_name: string; items: { product_name: string; qty: number; measure: Measure; total_cost_cents: number; expires_on: string | null }[] }[]>('/api/stock/purchases'));
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="stack">
      {can('stock.entry') && <Button variant="primary" icon={<PackagePlus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Nova entrada de mercadorias</Button>}
      {!data ? <Loading /> : data.length === 0 ? <Card><Empty icon={<Truck size={36} />} title="Nenhuma entrada registrada" /></Card> : (
        <Card flush>
          <div className="list">
            {data.map((p) => (
              <div key={p.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="strong">{p.supplier_name ?? 'Sem fornecedor'}{p.invoice_number && <span className="muted"> · NF {p.invoice_number}</span>}</div>
                  <div className="small muted">{fmtDateTime(p.purchased_at)} · {p.created_by_name}</div>
                  <div className="small" style={{ marginTop: 4 }}>{p.items.map((i) => `${i.product_name} (${formatQty(i.qty, i.measure)})`).join(' · ')}</div>
                </div>
                <span className="num strong">{formatBRL(p.total_cents)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {open && <PurchaseModal onClose={() => setOpen(false)} onDone={reload} />}
    </div>
  );
}

function PurchaseModal({ initialProduct, onClose, onDone }: { initialProduct?: Product; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const products = useTracked();
  const suppliers = useLoad(() => api.get<{ id: string; name: string }[]>('/api/suppliers'));
  const [supplierId, setSupplierId] = useState('');
  const [invoice, setInvoice] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<PurchaseLine[]>([{ productId: initialProduct?.id ?? '', packages: 1, packageQty: initialProduct ? initialProduct.packageQty / 1000 : null, totalCostCents: null, expiresOn: '' }]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const availableProducts = products.data ?? (initialProduct ? [initialProduct] : []);
  const byId = (id: string) => availableProducts.find((p) => p.id === id);
  const total = lines.reduce((a, l) => a + (l.totalCostCents ?? 0), 0);

  const submit = async () => {
    if (busy) return;
    for (const [i, l] of lines.entries()) {
      if (!l.productId) return toast.error(`Selecione o produto do item ${i + 1}.`);
      if (!l.packages || l.packages <= 0 || l.packages > 100_000 || !l.packageQty || l.packageQty <= 0 || Math.round(l.packages * l.packageQty * 1000) <= 0) return toast.error(`Confira a quantidade e o tamanho da embalagem do item ${i + 1}.`);
      if (l.totalCostCents === null || l.totalCostCents < 0) return toast.error(`Informe o custo total de compra do item ${i + 1}.`);
    }
    setBusy(true);
    try {
      let attachmentId: string | null = null;
      if (file) attachmentId = (await api.upload<{ id: string }>('/api/attachments?kind=invoice', file)).id;
      await api.post('/api/stock/purchases', {
        supplierId: supplierId || null, invoiceNumber: invoice || null, attachmentId,
        items: lines.map((l) => ({ productId: l.productId, packages: l.packages, packageQty: Math.round(l.packageQty! * 1000), totalCostCents: l.totalCostCents, expiresOn: l.expiresOn || null })),
      });
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

  return (
    <Modal title="Entrada de mercadorias" wide onClose={onClose} footer={<><span className="grow strong num">Total {formatBRL(total)}</span><Button disabled={busy} onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!products.data?.length} onClick={submit}>Registrar entrada</Button></>}>
      <div className="stack">
        {products.error && <ErrorBox error={products.error} onRetry={products.reload} />}
        {products.data?.length === 0 && <div className="banner warning">Cadastre um produto pelo botão “Novo produto” no estoque antes de registrar uma entrada.</div>}
        <p className="small muted">Selecione os produtos, informe quantas embalagens chegaram e o custo total da compra. O tamanho da embalagem já vem do cadastro.</p>
        <div className="input-group"><Search size={16} className="prefix" /><Input aria-label="Buscar produto para entrada" placeholder="Filtrar produtos por nome ou código…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <details className="optional-fields"><summary>Fornecedor, nota fiscal e comprovante (opcional)</summary><div className="grid-3">
          <Field label="Fornecedor"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">—</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Nota fiscal"><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
          <Field label="Arquivo da nota (opcional)"><input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        </div></details>
        {lines.map((l, i) => {
          const p = byId(l.productId);
          const unit = p ? BASE_UNIT[p.measure] : '';
          return (
            <Card key={i} tight>
              <div className="row between"><strong className="small">Item {i + 1}</strong><Button variant="plain" icon={<Trash2 size={15} />} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Remover item ${i + 1}`} /></div>
              <div className="purchase-line-grid">
                <Field label="Produto">
                  <Select value={l.productId} onChange={(e) => { const np = byId(e.target.value); setLine(i, { productId: e.target.value, packageQty: np ? np.packageQty / 1000 : null }); }}>
                    <option value="">Selecione…</option>
                    {availableProducts.filter((x) => x.id === l.productId || `${x.name} ${x.barcode ?? ''} ${x.internalCode ?? ''}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                </Field>
                <Field label={p?.measure === 'unit' && p.packageQty === 1000 ? 'Quantidade de unidades' : 'Quantidade de embalagens'}><DecimalInput value={l.packages} onChange={(v) => setLine(i, { packages: v })} /></Field>
                <Field label={`Conteúdo por embalagem (${unit || 'un'})`} hint="Preenchido pelo cadastro; altere se a embalagem da compra for diferente."><DecimalInput value={l.packageQty} onChange={(v) => setLine(i, { packageQty: v })} suffix={unit} /></Field>
                <Field label="Custo total de compra" hint="Valor pago por todas as embalagens deste item."><MoneyInput value={l.totalCostCents} onChange={(v) => setLine(i, { totalCostCents: v })} /></Field>
                <Field label="Validade (opcional)"><Input type="date" value={l.expiresOn} onChange={(e) => setLine(i, { expiresOn: e.target.value })} /></Field>
              </div>
              {p && l.packages && l.packageQty ? <div className="stock-entry-summary compact">Entrará no estoque: <strong>{formatQty(Math.round(l.packages * l.packageQty * 1000), p.measure)}</strong>{l.totalCostCents !== null ? ` · ${formatBRL(Math.round(l.totalCostCents / l.packages))} por embalagem` : ''}</div> : null}
            </Card>
          );
        })}
        <Button icon={<Plus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setLines([...lines, { productId: '', packages: 1, packageQty: null, totalCostCents: null, expiresOn: '' }])}>Adicionar item</Button>
      </div>
    </Modal>
  );
}

function Movements() {
  const [type, setType] = useState('');
  const products = useTracked();
  const [productId, setProductId] = useState('');
  const { data, error, reload } = useLoad(() => api.get<{ id: string; product_name: string; measure: Measure; type: StockMovementType; delta: number; balance_after: number; reason: string | null; user_name: string | null; created_at: string; cost_cents: number }[]>(`/api/stock/movements${qs({ type, productId, limit: 300 })}`), [type, productId]);
  return (
    <div className="stack">
      <div className="row wrap">
        <Select value={productId} onChange={(e) => setProductId(e.target.value)} style={{ width: 260 }}><option value="">Todos os produtos</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 220 }}><option value="">Todos os tipos</option>{Object.entries(STOCK_MOVEMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? <Loading /> : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Data</th><th>Produto</th><th>Tipo</th><th className="right">Quantidade</th><th className="right">Saldo</th><th>Responsável / motivo</th></tr></thead>
              <tbody>
                {data.map((m) => (
                  <tr key={m.id}>
                    <td className="small nowrap">{fmtDateTime(m.created_at)}</td>
                    <td>{m.product_name}</td>
                    <td><Badge color={m.delta > 0 ? 'green' : m.type === 'loss' ? 'red' : undefined}>{STOCK_MOVEMENT_TYPES[m.type]}</Badge></td>
                    <td className={`right num ${m.delta > 0 ? 'success-text' : ''}`}>{m.delta > 0 ? '+' : ''}{formatQty(m.delta, m.measure)}</td>
                    <td className="right num muted">{formatQty(m.balance_after, m.measure)}</td>
                    <td className="small muted">{m.user_name ?? 'Sistema'}{m.reason && ` · ${m.reason}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
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
  const [counts, setCounts] = useState<Record<string, { closed: number | null; open: number | null }>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ items: { name: string; expected: number; counted: number; diff: number; costCents: number; productId: string }[] } | null>(null);

  const submit = async () => {
    const items = Object.entries(counts)
      .filter(([, c]) => c.closed !== null || c.open !== null)
      .map(([productId, c]) => {
        const p = products.data!.find((x) => x.id === productId)!;
        return { productId, countedQty: Math.round((c.closed ?? 0) * p.packageQty + (c.open ?? 0) * 1000) };
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
                  const m = (p?.measure ?? 'unit') as Measure;
                  return <tr key={i.productId}><td>{i.name}</td><td className="right num">{formatQty(i.expected, m)}</td><td className="right num">{formatQty(i.counted, m)}</td><td className={`right num ${i.diff < 0 ? 'danger-text' : i.diff > 0 ? 'warning-text' : ''}`}>{i.diff > 0 ? '+' : ''}{formatQty(i.diff, m)}</td></tr>;
                })}
              </tbody></table></div>
            </Card>
          )}
          <Card title="Inventários anteriores" flush>
            <div className="list">
              {history.data?.length === 0 && <div className="list-item muted">Nenhum inventário ainda.</div>}
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
          <p className="small muted" style={{ marginBottom: 12 }}>Informe embalagens fechadas e o restante da embalagem aberta (estimado ou pesado). Deixe em branco o que não foi contado. As divergências viram ajustes registrados.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Produto</th><th className="right">Sistema</th><th>Fechadas</th><th>Aberta (restante)</th></tr></thead>
              <tbody>
                {products.data.map((p) => (
                  <tr key={p.id}>
                    <td><div className="strong">{p.name}</div><div className="tiny muted">{p.packageLabel ?? 'embalagem'} de {formatQty(p.packageQty, p.measure)}</div></td>
                    <td className="right num muted">{formatQty(p.stockQty, p.measure)}</td>
                    <td style={{ width: 130 }}><DecimalInput value={counts[p.id]?.closed ?? null} onChange={(v) => setCounts({ ...counts, [p.id]: { closed: v, open: counts[p.id]?.open ?? null } })} /></td>
                    <td style={{ width: 160 }}><DecimalInput value={counts[p.id]?.open ?? null} onChange={(v) => setCounts({ ...counts, [p.id]: { closed: counts[p.id]?.closed ?? null, open: v } })} suffix={BASE_UNIT[p.measure]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Field label="Observações"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </Card>
      )}
    </div>
  );
}

function Lots() {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useLoad(() => api.get<{ id: string; product_name: string; measure: Measure; lot_code: string | null; expires_on: string; qty_remaining: number; expired: boolean }[]>(`/api/stock/lots?days=${days}`), [days]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <Select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 240 }}>
        <option value={7}>Vencendo em 7 dias</option>
        <option value={30}>Vencendo em 30 dias</option>
        <option value={90}>Vencendo em 90 dias</option>
      </Select>
      {!data ? <Loading /> : data.length === 0 ? <Card><Empty title="Nenhum lote vencendo no período" /></Card> : (
        <Card flush>
          <div className="list">
            {data.map((l) => (
              <div key={l.id} className="list-item">
                <div className="grow"><div className="strong">{l.product_name}</div><div className="small muted">{l.lot_code ? `Lote ${l.lot_code} · ` : ''}restante {formatQty(l.qty_remaining, l.measure)}</div></div>
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
