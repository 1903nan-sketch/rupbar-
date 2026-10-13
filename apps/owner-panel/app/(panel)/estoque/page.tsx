import { formatQty, packageBreakdown, stockLevel, type Measure } from '@rupbar/core';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
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
  const rows = (products ?? []).map((p) => ({ ...p, level: stockLevel(Number(p.stock_qty), Number(p.min_stock)) })).filter((p) => !onlyLow || p.level !== 'ok');
  return (
    <div className="stack-l">
      <PageHeader title="Estoque" subtitle="Saldos enviados pelo PC do bar (autoridade do estoque)." actions={
        <div className="segmented"><a className={`${!onlyLow ? 'active' : ''}`} href="?" style={{ padding: '6px 14px', borderRadius: 8, color: 'inherit' }}>Todos</a><a className={`${onlyLow ? 'active' : ''}`} href="?filtro=baixo" style={{ padding: '6px 14px', borderRadius: 8, color: 'inherit' }}>Abaixo do mínimo</a></div>
      } />
      <Card flush>
        {!rows.length ? <Empty title="Nada a exibir" /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Produto</th><th>Categoria</th><th className="right">Saldo</th><th className="right">Embalagens</th><th className="right">Mínimo</th><th>Situação</th></tr></thead><tbody>
            {rows.map((p) => {
              const m = p.measure as Measure;
              const pk = packageBreakdown(Number(p.stock_qty), Number(p.package_qty));
              const [label, color] = LEVEL[p.level as keyof typeof LEVEL];
              return (
                <tr key={p.id as string}>
                  <td className="strong">{p.name as string}</td>
                  <td className="muted">{catName.get(p.category_id as string) ?? '—'}</td>
                  <td className="right num strong">{formatQty(Number(p.stock_qty), m)}</td>
                  <td className="right small muted">{Number(p.package_qty) > 1000 ? `${pk.closed} fechada(s)${pk.hasOpen ? ` + ${formatQty(pk.openRemaining, m)}` : ''}` : '—'}</td>
                  <td className="right num muted">{Number(p.min_stock) ? formatQty(Number(p.min_stock), m) : '—'}</td>
                  <td><Badge color={color}>{label}</Badge></td>
                </tr>
              );
            })}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
