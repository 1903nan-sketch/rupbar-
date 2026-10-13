import { formatQty, packageBreakdown, stockLevel, type Measure } from '@rupbar/core';
import { Boxes, PackageCheck, PackageX, TriangleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Badge, Card, Empty, LinkTabs, PageHeader, Stat } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';

export const metadata = { title: 'Estoque' };

const LEVEL = { ok: ['OK', 'green'], low: ['Baixo', 'orange'], out: ['Zerado', 'red'], negative: ['Negativo', 'red'] } as const;

export default async function Stock({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const onlyLow = params.filtro === 'baixo';
  const [{ data: products }, { data: cats }] = await Promise.all([
    sb.from('v_products').select('*').eq('establishment_id', est.id).eq('active', true).eq('stock_tracked', true).order('name'),
    sb.from('v_categories').select('id, name').eq('establishment_id', est.id),
  ]);
  const catName = new Map((cats ?? []).map((c) => [c.id as string, c.name as string]));
  const all = (products ?? []).map((p) => ({ ...p, level: stockLevel(Number(p.stock_qty), Number(p.min_stock)) }));
  const rows = all.filter((p) => !onlyLow || p.level !== 'ok');
  const low = all.filter((p) => p.level === 'low').length;
  const out = all.filter((p) => p.level === 'out' || p.level === 'negative').length;

  return (
    <div className="stack-l">
      <PageHeader
        title="Estoque"
        eyebrow="Produtos"
        icon={Boxes}
        subtitle="Saldos enviados pelo PC do bar (autoridade do estoque)."
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

      <div className="grid-3 stagger">
        <Stat label="Produtos controlados" value={all.length.toLocaleString('pt-BR')} hint="ativos com controle de estoque" icon={PackageCheck} tone="teal" />
        <Stat label="Abaixo do mínimo" value={low.toLocaleString('pt-BR')} hint="precisam de reposição em breve" icon={TriangleAlert} tone="amber" />
        <Stat label="Zerados ou negativos" value={out.toLocaleString('pt-BR')} hint="sem saldo para venda" icon={PackageX} tone="rose" />
      </div>

      <Card flush className="reveal">
        {!rows.length ? (
          <Empty title={onlyLow ? 'Nenhum produto abaixo do mínimo' : 'Nada a exibir'} icon={onlyLow ? PackageCheck : Boxes}>
            {onlyLow ? 'Ótimo! Todo o estoque está acima do mínimo definido.' : 'Os produtos aparecem aqui depois da sincronização com o PC do bar.'}
          </Empty>
        ) : (
          <div className="table-wrap tall">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  <th scope="col">Categoria</th>
                  <th scope="col" className="right">Saldo</th>
                  <th scope="col" className="hide-sm">Nível</th>
                  <th scope="col" className="right">Embalagens</th>
                  <th scope="col" className="right">Mínimo</th>
                  <th scope="col">Situação</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const m = p.measure as Measure;
                  const stock = Number(p.stock_qty);
                  const min = Number(p.min_stock);
                  const pk = packageBreakdown(stock, Number(p.package_qty));
                  const [label, color] = LEVEL[p.level as keyof typeof LEVEL];
                  // Medidor: 100% = 2× o mínimo (ou o próprio saldo, sem mínimo definido).
                  const ref = min > 0 ? min * 2 : Math.max(stock, 1);
                  const fill = Math.max(0, Math.min(100, (stock / ref) * 100));
                  return (
                    <tr key={p.id as string}>
                      <td className="strong">{p.name as string}</td>
                      <td className="muted">{catName.get(p.category_id as string) ?? '—'}</td>
                      <td className="right num strong">{formatQty(stock, m)}</td>
                      <td className="hide-sm">
                        <span className={`meter ${color}`} aria-hidden="true">
                          <span style={{ ['--w' as string]: `${fill}%` } as CSSProperties} />
                        </span>
                      </td>
                      <td className="right small muted">{Number(p.package_qty) > 1000 ? `${pk.closed} fechada(s)${pk.hasOpen ? ` + ${formatQty(pk.openRemaining, m)}` : ''}` : '—'}</td>
                      <td className="right num muted">{min ? formatQty(min, m) : '—'}</td>
                      <td>
                        <Badge color={color} dot>
                          {label}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
