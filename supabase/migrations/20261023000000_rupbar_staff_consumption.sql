-- RupBar 0.3: consumo de funcionário (comanda do tipo 'staff'). O PC marca os
-- itens dessas comandas com staff = 1: baixam o estoque, não são cobrados e
-- ficam fora das vendas. Só acrescenta (coluna nova no fim da visão).

create or replace view public.v_comanda_items with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'comanda_id')::uuid as comanda_id,
  (data ->> 'product_id')::uuid as product_id,
  (data ->> 'category_id')::uuid as category_id,
  data ->> 'kind' as kind,
  data ->> 'product_name' as product_name,
  data ->> 'presentation_name' as presentation_name,
  (data ->> 'quantity')::int as quantity,
  (data ->> 'unit_price_cents')::bigint as unit_price_cents,
  (data ->> 'unit_cost_cents')::bigint as unit_cost_cents,
  data ->> 'status' as status,
  data ->> 'cancel_reason' as cancel_reason,
  (data ->> 'created_at')::timestamptz as created_at,
  coalesce((data ->> 'staff')::int, 0) = 1 as staff
from public.sync_records where entity = 'comanda_item' and not deleted;

-- Vendas sem o consumo de funcionário; o consumo vem à parte (valor de cardápio e custo).
create or replace function public.rupbar_sales_summary(p_establishment_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
set search_path = public
as $$
  with all_items as (
    select * from public.v_comanda_items
    where establishment_id = p_establishment_id and status = 'active' and created_at >= p_from and created_at < p_to
  ), items as (
    select * from all_items where not staff
  ), staff_items as (
    select * from all_items where staff
  ), pays as (
    select * from public.v_payments
    where establishment_id = p_establishment_id and status = 'active' and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'grossCents', coalesce((select sum(quantity * unit_price_cents) from items), 0),
    'costCents', coalesce((select sum(quantity * unit_cost_cents) from items), 0),
    'itemsSold', coalesce((select sum(quantity) from items), 0),
    'receivedCents', coalesce((select sum(amount_cents) from pays), 0),
    'closedComandas', (select count(*) from public.v_comandas where establishment_id = p_establishment_id and status = 'closed'
                        and kind <> 'staff' and closed_at >= p_from and closed_at < p_to),
    'staffCents', coalesce((select sum(quantity * unit_price_cents) from staff_items), 0),
    'staffCostCents', coalesce((select sum(quantity * unit_cost_cents) from staff_items), 0),
    'byDay', coalesce((select jsonb_agg(d order by d.day) from (
        select to_char((created_at at time zone 'America/Sao_Paulo') - interval '5 hours', 'YYYY-MM-DD') as day,
               sum(quantity * unit_price_cents) as total, sum(quantity * unit_cost_cents) as cost
        from items group by 1) d), '[]'::jsonb),
    'byMethod', coalesce((select jsonb_agg(m order by m.total desc) from (
        select method, count(*) as count, sum(amount_cents) as total from pays group by method) m), '[]'::jsonb),
    'byCategory', coalesce((select jsonb_agg(c order by c.total desc) from (
        select coalesce(cat.name, 'Narguilé') as category, sum(i.quantity) as qty, sum(i.quantity * i.unit_price_cents) as total,
               sum(i.quantity * i.unit_cost_cents) as cost
        from items i left join public.v_categories cat on cat.id = i.category_id and cat.establishment_id = i.establishment_id
        group by 1) c), '[]'::jsonb),
    'topProducts', coalesce((select jsonb_agg(t order by t.total desc) from (
        select product_id, product_name, presentation_name, sum(quantity) as qty, sum(quantity * unit_price_cents) as total,
               sum(quantity * unit_cost_cents) as cost
        from items where kind = 'product' group by product_id, product_name, presentation_name
        order by total desc limit 30) t), '[]'::jsonb)
  );
$$;

create or replace function public.rupbar_product_comparison(p_establishment_id uuid, p_from timestamptz, p_to timestamptz, p_product_ids uuid[])
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(x order by x.total desc), '[]'::jsonb) from (
    select p.id as product_id, p.name,
      coalesce(sum(i.quantity), 0) as qty,
      coalesce(sum(i.quantity * i.unit_price_cents), 0) as total,
      coalesce(sum(i.quantity * i.unit_cost_cents), 0) as cost,
      coalesce((select sum(l.cost_cents) from public.v_losses l where l.establishment_id = p.establishment_id and l.product_id = p.id
                and l.status = 'applied' and l.occurred_at >= p_from and l.occurred_at < p_to), 0) as loss_cost
    from public.v_products p
    left join public.v_comanda_items i on i.establishment_id = p.establishment_id and i.product_id = p.id and i.status = 'active'
      and not i.staff and i.created_at >= p_from and i.created_at < p_to
    where p.establishment_id = p_establishment_id and p.id = any (p_product_ids)
    group by p.establishment_id, p.id, p.name
  ) x;
$$;
