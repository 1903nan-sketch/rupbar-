import { bigUnitName, costOf, formatBRL, formatQty, KILO, MILLI, packageBreakdown, stockLevel, unitsText, type Measure } from '@rupbar/core';
import { Boxes, Package, PackageCheck, PackageX, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { CommandFeed } from '@/components/CommandFeed';
import { ScrollHere } from '@/components/ScrollHere';
import { Card, Empty, LinkTabs, PageHeader, Stat } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';
import { StockBrowser, type StockRow } from './StockBrowser';
import { StockForms } from './StockForms';

export const metadata = { title: 'Estoque' };

const LEVEL = { ok: ['OK', 'green'], low: ['Baixo', 'orange'], out: ['Zerado', 'red'], negative: ['Negativo', 'red'] } as const;

export default async function Stock({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const onlyLow = params.filtro === 'baixo';
  const selectedId = typeof params.produto === 'string' && /^[0-9a-f-]{36}$/.test(params.produto) ? params.produto : null;
  const query = onlyLow ? 'filtro=baixo' : '';
  const [{ data: products }, { data: cats }] = await Promise.all([
    sb.from('v_products').select('*').eq('establishment_id', est.id).eq('active', true).eq('stock_tracked', true).order('name'),
    sb.from('v_categories').select('id, name').eq('establishment_id', est.id),
  ]);
  const catName = new Map((cats ?? []).map((c) => [c.id as string, c.name as string]));
  const all = (products ?? []).map((p): StockRow & { level: keyof typeof LEVEL } => {
    const m = p.measure as Measure;
    const stock = Number(p.stock_qty);
    const min = Number(p.min_stock);
    const level = stockLevel(stock, min);
    const pk = packageBreakdown(stock, Number(p.package_qty));
    const [label, color] = LEVEL[level];
    // Com nome da unidade (lata, long neck): "30 latas"; senão "30 un", "1,8 kg".
    const text = (qty: number) => (m === 'unit' && p.unit_label
      ? unitsText(qty, { measure: m, packageQty: Number(p.package_qty), packageLabel: p.package_label as string | null, unitLabel: p.unit_label as string })
      : formatQty(qty, m));
    // Medidor: 100% = 2× o mínimo (ou o próprio saldo, sem mínimo definido).
    const ref = min > 0 ? min * 2 : Math.max(stock, 1);
    return {
      id: p.id as string,
      name: p.name as string,
      category: catName.get(p.category_id as string) ?? 'Sem categoria',
      qty: text(stock),
      packages: Number(p.package_qty) <= 1000 ? null
        : pk.closed ? `${pk.closed} fechada(s)${pk.hasOpen ? ` + ${formatQty(pk.openRemaining, m)}` : ''}`
        : pk.hasOpen ? `só a aberta (${formatQty(pk.openRemaining, m)})` : null,
      min: min ? text(min) : null,
      label,
      color,
      fill: Math.max(0, Math.min(100, (stock / ref) * 100)),
      level,
    };
  });
  const rows = all.filter((p) => !onlyLow || p.level !== 'ok');
  const raw = (products ?? []).find((p) => p.id === selectedId);
  const sel = raw && all.find((p) => p.id === raw.id);
  const selMeasure = raw?.measure as Measure | undefined;
  // Custo médio das entradas por un, kg ou L.
  const unitCost = raw && Number(raw.unit_cost_e4) > 0 && selMeasure
    ? `${formatBRL(costOf(selMeasure === 'unit' ? MILLI : KILO, Number(raw.unit_cost_e4)))}/${bigUnitName(selMeasure) ?? (raw.unit_label as string | null) ?? 'un'}`
    : null;
  const low = all.filter((p) => p.level === 'low').length;
  const out = all.filter((p) => p.level === 'out' || p.level === 'negative').length;

  return (
    <div className="stack-l">
      <PageHeader
        title="Estoque"
        eyebrow="Produtos"
        icon={Boxes}
        subtitle="Saldos enviados pelo PC do bar. Toque num produto para dar entrada, corrigir o saldo ou mudar o mínimo; o PC aplica em segundos."
        actions={
          <LinkTabs
            label="Filtro do estoque"
            items={[
              { href: '/estoque', label: 'Todos', active: !onlyLow, count: all.length },
              { href: '/estoque?filtro=baixo', label: 'Abaixo do mínimo', active: onlyLow, count: low + out },
            ]}
          />
        }
      />

      <div className="grid-3 stagger stock-stats">
        <Stat label="Produtos controlados" value={all.length.toLocaleString('pt-BR')} hint="ativos com controle de estoque" icon={PackageCheck} tone="teal" />
        <Stat label="Abaixo do mínimo" value={low.toLocaleString('pt-BR')} hint="precisam de reposição em breve" icon={TriangleAlert} tone="amber" />
        <Stat label="Zerados ou negativos" value={out.toLocaleString('pt-BR')} hint="sem saldo para venda" icon={PackageX} tone="rose" />
      </div>

      {raw && sel && selMeasure && (
        <div className="split-form wide-first">
          <Card
            key={raw.id as string}
            id="produto"
            className="detail-card"
            title={
              <div>
                <h2 className="card-title">{raw.name as string}</h2>
                <p className="card-sub">
                  {sel.category} · saldo <strong>{sel.qty}</strong>{sel.min ? ` · mínimo ${sel.min}` : ''}{unitCost ? ` · custo médio ${unitCost}` : ''}
                </p>
              </div>
            }
            icon={Package}
            tone="teal"
            actions={
              <Link href={`/estoque${query ? `?${query}` : ''}`} className="btn ghost icon" aria-label="Fechar o produto na tela" scroll={false}>
                <X size={18} aria-hidden="true" />
              </Link>
            }
          >
            <ScrollHere />
            <StockForms
              product={{
                id: raw.id as string, name: raw.name as string, measure: selMeasure, packageQty: Number(raw.package_qty),
                packageLabel: (raw.package_label as string | null) ?? null, unitLabel: (raw.unit_label as string | null) ?? null,
                stockQty: Number(raw.stock_qty), minStock: Number(raw.min_stock),
              }}
            />
          </Card>
          <CommandFeed types={['stock.entry', 'stock.adjust', 'product.update']} path="/estoque" />
        </div>
      )}

      <Card flush className="reveal">
        {!rows.length ? (
          <Empty title={onlyLow ? 'Nenhum produto abaixo do mínimo' : 'Nada a exibir'} icon={onlyLow ? PackageCheck : Boxes}>
            {onlyLow ? 'Ótimo! Todo o estoque está acima do mínimo definido.' : 'Os produtos aparecem aqui depois da sincronização com o PC do bar.'}
          </Empty>
        ) : (
          <StockBrowser rows={rows} query={query} selectedId={selectedId} />
        )}
      </Card>
    </div>
  );
}
