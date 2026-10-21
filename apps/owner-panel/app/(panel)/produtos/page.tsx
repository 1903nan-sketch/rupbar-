import { formatBRL } from '@rupbar/core';
import { Ban, PackageCheck, RotateCcw, ShoppingBag, Tags } from 'lucide-react';
import { ActionForm } from '@/components/ActionForm';
import { CommandFeed } from '@/components/CommandFeed';
import { Badge, Card, Empty, LinkTabs, PageHeader, Stat } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';
import { setProductActive } from '../acoes';

export const metadata = { title: 'Produtos' };

/** Produtos do cardápio: tirar da venda (some do cardápio do PC e dos celulares) ou voltar à venda. */
export default async function Products({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const view = params.ver === 'fora' ? 'fora' : 'venda';
  const q = typeof params.q === 'string' ? params.q.trim().toLocaleLowerCase('pt-BR') : '';
  const [{ data: products }, { data: cats }, { data: pres }] = await Promise.all([
    sb.from('v_products').select('id, name, category_id, active').eq('establishment_id', est.id).order('name'),
    sb.from('v_categories').select('id, name').eq('establishment_id', est.id),
    sb.from('v_presentations').select('product_id, name, price_cents, active').eq('establishment_id', est.id).eq('active', true),
  ]);
  const cat = new Map((cats ?? []).map((c) => [c.id as string, c.name as string]));
  const prices = new Map<string, number[]>();
  for (const p of pres ?? []) prices.set(p.product_id as string, [...(prices.get(p.product_id as string) ?? []), Number(p.price_cents)]);
  const all = (products ?? []).map((p) => ({ id: p.id as string, name: p.name as string, active: p.active as boolean, category: cat.get(p.category_id as string) ?? '—', prices: prices.get(p.id as string) ?? [] }));
  const rows = all.filter((p) => (view === 'fora' ? !p.active : p.active) && (!q || `${p.name} ${p.category}`.toLocaleLowerCase('pt-BR').includes(q)));
  const onSale = all.filter((p) => p.active).length;

  return (
    <div className="stack-l">
      <PageHeader
        title="Produtos"
        eyebrow="Cardápio"
        icon={Tags}
        subtitle="Tire um produto da venda (some do cardápio do PC e dos celulares) ou volte a vender. O histórico de vendas continua."
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
      <div className="grid-3 stagger">
        <Stat label="À venda" value={onSale.toLocaleString('pt-BR')} hint="no cardápio agora" icon={ShoppingBag} tone="teal" />
        <Stat label="Fora de venda" value={(all.length - onSale).toLocaleString('pt-BR')} hint="podem voltar quando quiser" icon={Ban} tone="amber" />
        <Stat label="Categorias" value={new Set(all.map((p) => p.category)).size.toLocaleString('pt-BR')} icon={Tags} tone="violet" />
      </div>
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
                    <div className="strong">{p.name}</div>
                    <div className="tiny muted">
                      {p.category}
                      {p.prices.length ? ` · ${p.prices.length > 1 ? `de ${formatBRL(Math.min(...p.prices))} a ${formatBRL(Math.max(...p.prices))}` : formatBRL(p.prices[0]!)}` : ' · só estoque (sem preço)'}
                    </div>
                  </div>
                  {!p.active && <Badge color="gray">Fora de venda</Badge>}
                  <ActionForm action={setProductActive} compact reset={false} submit={p.active ? 'Tirar da venda' : 'Voltar à venda'} icon={p.active ? Ban : RotateCcw} variant={p.active ? 'ghost' : 'primary'}
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
        <CommandFeed types={['product.set_active']} path="/produtos" />
      </div>
    </div>
  );
}
