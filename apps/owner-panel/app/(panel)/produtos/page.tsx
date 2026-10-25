import { formatBRL } from '@rupbar/core';
import { Ban, Boxes, PackageCheck, RotateCcw, Tag, Tags, X } from 'lucide-react';
import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { CommandFeed } from '@/components/CommandFeed';
import { ScrollHere } from '@/components/ScrollHere';
import { Badge, Card, Empty, LinkTabs, PageHeader } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';
import { setProductActive } from '../acoes';
import { PriceEditor } from './PriceEditor';

export const metadata = { title: 'Produtos' };

/** Produtos do cardápio: tirar da venda (some do cardápio do PC e dos celulares) ou voltar à venda. */
export default async function Products({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const view = params.ver === 'fora' ? 'fora' : 'venda';
  const q = typeof params.q === 'string' ? params.q.trim().toLocaleLowerCase('pt-BR') : '';
  const selectedId = typeof params.produto === 'string' && /^[0-9a-f-]{36}$/.test(params.produto) ? params.produto : null;
  const keep = new URLSearchParams({ ...(view === 'fora' ? { ver: 'fora' } : {}), ...(q ? { q } : {}) }).toString();
  const href = (id: string) => `?${keep ? `${keep}&` : ''}produto=${id}`;
  const [{ data: products }, { data: cats }, { data: pres }] = await Promise.all([
    sb.from('v_products').select('id, name, category_id, active, stock_tracked').eq('establishment_id', est.id).order('name'),
    sb.from('v_categories').select('id, name').eq('establishment_id', est.id),
    sb.from('v_presentations').select('id, product_id, name, price_cents, active, sort_order').eq('establishment_id', est.id).eq('active', true).order('sort_order'),
  ]);
  const cat = new Map((cats ?? []).map((c) => [c.id as string, c.name as string]));
  const prices = new Map<string, number[]>();
  for (const p of pres ?? []) prices.set(p.product_id as string, [...(prices.get(p.product_id as string) ?? []), Number(p.price_cents)]);
  const all = (products ?? []).map((p) => ({ id: p.id as string, name: p.name as string, active: p.active as boolean, category: cat.get(p.category_id as string) ?? '—', prices: prices.get(p.id as string) ?? [] }));
  const rows = all.filter((p) => (view === 'fora' ? !p.active : p.active) && (!q || `${p.name} ${p.category}`.toLocaleLowerCase('pt-BR').includes(q)));
  const onSale = all.filter((p) => p.active).length;
  const sel = selectedId ? (products ?? []).find((p) => p.id === selectedId) : null;
  const selPrices = sel ? (pres ?? []).filter((x) => x.product_id === sel.id).map((x) => ({ id: x.id as string, name: x.name as string, priceCents: Number(x.price_cents) })) : [];

  return (
    <div className="stack-l">
      <PageHeader
        title="Produtos"
        eyebrow="Cardápio"
        icon={Tags}
        subtitle="Toque no nome para mudar os preços. Tire um produto da venda (some do cardápio do PC e dos celulares) ou volte a vender. O histórico de vendas continua."
        actions={
          <LinkTabs
            label="Produtos"
            items={[
              { href: '/produtos', label: 'À venda', active: view === 'venda', count: onSale },
              { href: '/produtos?ver=fora', label: 'Fora de venda', active: view === 'fora', count: all.length - onSale },
            ]}
          />
        }
      />
      {sel && (
        <Card
          key={sel.id as string}
          id="produto"
          className="detail-card"
          title={
            <div>
              <h2 className="card-title">Preços — {sel.name as string}</h2>
              <p className="card-sub">{cat.get(sel.category_id as string) ?? '—'} · o novo preço vale para os próximos pedidos (os já lançados não mudam).</p>
            </div>
          }
          icon={Tag}
          tone="violet"
          actions={
            <Link href={`/produtos${keep ? `?${keep}` : ''}`} className="btn ghost icon" aria-label="Fechar o produto na tela" scroll={false}>
              <X size={18} aria-hidden="true" />
            </Link>
          }
        >
          <ScrollHere />
          {selPrices.length ? (
            <PriceEditor productId={sel.id as string} productName={sel.name as string} rows={selPrices} />
          ) : (
            <p className="small muted">Este produto não tem preço de venda (é insumo ou só estoque).</p>
          )}
          {Boolean(sel.stock_tracked) && (
            <Link href={`/estoque?produto=${sel.id as string}`} className="btn ghost small stock-shortcut">
              <Boxes size={15} aria-hidden="true" /> Estoque deste produto: entrada, contagem e mínimo
            </Link>
          )}
        </Card>
      )}
      <div className="split-form wide-first">
        <Card title={view === 'fora' ? 'Fora de venda' : 'À venda'} icon={PackageCheck} flush
          actions={
            <form className="search-form" role="search">
              {view === 'fora' && <input type="hidden" name="ver" value="fora" />}
              <input className="input" name="q" defaultValue={q} placeholder="Buscar produto" aria-label="Buscar produto" />
            </form>
          }>
          {!rows.length ? (
            <Empty title={q ? 'Nada encontrado' : view === 'fora' ? 'Nenhum produto fora de venda' : 'Nenhum produto à venda'} icon={Tags}>
              {q ? 'Tente outro nome.' : 'Os produtos são cadastrados no PC do bar.'}
            </Empty>
          ) : (
            <ul className="list scroll-list tall">
              {rows.map((p) => (
                <li key={p.id} className="list-item">
                  <div className="grow">
                    <Link href={href(p.id)} scroll={false} className="strong row-link">{p.name}</Link>
                    <div className="tiny muted">
                      {p.category}
                      {p.prices.length ? ` · ${p.prices.length > 1 ? `de ${formatBRL(Math.min(...p.prices))} a ${formatBRL(Math.max(...p.prices))}` : formatBRL(p.prices[0]!)}` : ' · só estoque (sem preço)'}
                    </div>
                  </div>
                  {!p.active && <Badge color="gray">Fora de venda</Badge>}
                  <ActionForm action={setProductActive} compact reset={false} submit={p.active ? 'Tirar da venda' : 'Voltar à venda'} icon={p.active ? <Ban size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />} variant={p.active ? 'ghost' : 'primary'}
                    confirm={p.active ? `Tirar "${p.name}" da venda? Ele some do cardápio do PC e dos celulares.` : undefined}>
                    <input type="hidden" name="productId" value={p.id} />
                    <input type="hidden" name="name" value={p.name} />
                    <input type="hidden" name="active" value={p.active ? '0' : '1'} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <CommandFeed types={['product.set_active', 'product.update']} path="/produtos" />
      </div>
    </div>
  );
}
