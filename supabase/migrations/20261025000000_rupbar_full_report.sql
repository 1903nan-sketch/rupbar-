-- RupBar 0.5: relatório completo no painel (venda do dia ou de vários dias),
-- no mesmo formato do PC do bar (FullReport em packages/core/src/report.ts),
-- para tela e PDF. O dia do bar vai das 05:00 às 05:00 (Brasília). Só acrescenta.

create or replace function public.rupbar_full_report(p_establishment_id uuid, p_de date, p_ate date)
returns jsonb
language sql
stable
set search_path = public
as $$
  with w as (
    select least(p_de, p_ate) as de, greatest(p_de, p_ate) as ate,
           ((least(p_de, p_ate) + time '05:00') at time zone 'America/Sao_Paulo') as f,
           ((greatest(p_de, p_ate) + 1 + time '05:00') at time zone 'America/Sao_Paulo') as t
  ),
  rec as materialized (
    select entity, id, data from public.sync_records
    where establishment_id = p_establishment_id and not deleted
      and entity in ('comanda_item', 'comanda', 'payment', 'user', 'category', 'cash_session', 'cash_movement', 'loss', 'product', 'hookah_session')
  ),
  usr as (select id, data ->> 'name' as name from rec where entity = 'user'),
  items as materialized (
    select (data ->> 'comanda_id')::uuid as comanda_id, (data ->> 'category_id')::uuid as category_id,
      data ->> 'product_name' as product_name, coalesce(data ->> 'presentation_name', '') as presentation_name,
      (data ->> 'quantity')::bigint as qty, (data ->> 'unit_price_cents')::bigint as price,
      coalesce((data ->> 'unit_cost_cents')::bigint, 0) as cost, data ->> 'status' as status,
      coalesce((data ->> 'staff')::int, 0) = 1 as staff,
      (data ->> 'created_at')::timestamptz as created_at, data ->> 'canceled_at' as canceled_at_txt,
      (data ->> 'canceled_at')::timestamptz as canceled_at,
      (data ->> 'created_by')::uuid as created_by, (data ->> 'canceled_by')::uuid as canceled_by,
      data ->> 'order_id' as order_id, data ->> 'cancel_reason' as cancel_reason
    from rec where entity = 'comanda_item'
  ),
  sold as (select i.* from items i, w where i.status = 'active' and not i.staff and i.created_at >= w.f and i.created_at < w.t),
  com as materialized (
    select id, (data ->> 'number')::int as number, (data ->> 'card_number')::int as card_number, coalesce(data ->> 'kind', 'regular') as kind,
      data ->> 'status' as status, data ->> 'customer_name' as customer_name, coalesce((data ->> 'discount_cents')::bigint, 0) as discount,
      data ->> 'discount_reason' as discount_reason, coalesce((data ->> 'service_fee_bp')::int, 0) as bp,
      (data ->> 'opened_at')::timestamptz as opened_at, (data ->> 'closed_at')::timestamptz as closed_at, data ->> 'closed_at' as closed_at_txt,
      (data ->> 'canceled_at')::timestamptz as canceled_at, (data ->> 'closed_by')::uuid as closed_by, (data ->> 'staff_user_id')::uuid as staff_user_id
    from rec where entity = 'comanda'
  ),
  -- Comandas encerradas no período (desconto nunca maior que os itens) e as abertas no período ainda sem fechar.
  chosen as (
    select c.*, (c.status = 'closed' and c.kind <> 'staff' and c.closed_at >= w.f and c.closed_at < w.t) as closed_in,
           (c.status = 'open' and c.kind = 'regular' and c.opened_at >= w.f and c.opened_at < w.t) as open_in
    from com c, w
    where (c.status = 'closed' and c.kind <> 'staff' and c.closed_at >= w.f and c.closed_at < w.t)
       or (c.status = 'open' and c.kind = 'regular' and c.opened_at >= w.f and c.opened_at < w.t)
  ),
  sub as (
    select c.id, coalesce(sum(i.qty * i.price) filter (where i.status = 'active'), 0) as subtotal
    from chosen c left join items i on i.comanda_id = c.id group by c.id
  ),
  closed as (
    select c.*, s.subtotal, least(c.discount, s.subtotal) as eff_discount from chosen c join sub s on s.id = c.id where c.closed_in
  ),
  pays as (
    select data ->> 'method' as method, (data ->> 'amount_cents')::bigint as amount, data ->> 'status' as status,
      (data ->> 'created_at')::timestamptz as created_at, (data ->> 'reversed_at')::timestamptz as reversed_at,
      (data ->> 'cash_session_id')::uuid as session_id
    from rec where entity = 'payment'
  ),
  received as (select p.* from pays p, w where p.status = 'active' and p.created_at >= w.f and p.created_at < w.t),
  moves as (
    select (data ->> 'session_id')::uuid as session_id, data ->> 'type' as type, (data ->> 'amount_cents')::bigint as amount,
      data ->> 'reason' as reason, (data ->> 'created_by')::uuid as created_by, data ->> 'created_at' as created_at_txt,
      (data ->> 'created_at')::timestamptz as created_at
    from rec where entity = 'cash_movement' and coalesce(data ->> 'status', 'active') = 'active'
  ),
  loss as (
    select coalesce(p.data ->> 'name', '—') as product, l.data ->> 'reason' as reason, count(*) as cnt,
      coalesce(sum((l.data ->> 'cost_cents')::bigint), 0) as cost
    from rec l left join rec p on p.entity = 'product' and p.id = (l.data ->> 'product_id')::uuid, w
    where l.entity = 'loss' and l.data ->> 'status' = 'applied'
      and (l.data ->> 'occurred_at')::timestamptz >= w.f and (l.data ->> 'occurred_at')::timestamptz < w.t
    group by p.id, p.data ->> 'name', l.data ->> 'reason'
  ),
  hk as (
    select count(*) as sessions, coalesce(sum((data ->> 'charge_cents')::bigint), 0) as total from rec, w
    where entity = 'hookah_session' and data ->> 'status' <> 'canceled'
      and (data ->> 'started_at')::timestamptz >= w.f and (data ->> 'started_at')::timestamptz < w.t
  )
  select jsonb_build_object(
    'barName', coalesce((select trade_name from public.establishments where id = p_establishment_id), 'RupBar'),
    'from', (select to_char(f at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from w),
    'to', (select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from w),
    'de', (select to_char(de, 'YYYY-MM-DD') from w),
    'ate', (select to_char(ate, 'YYYY-MM-DD') from w),
    'generatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'summary', jsonb_build_object(
      'grossCents', (select coalesce(sum(qty * price), 0) from sold),
      'discountsCents', (select coalesce(sum(eff_discount), 0) from closed),
      'serviceFeeCents', (select coalesce(sum(round(((subtotal - eff_discount) * bp)::numeric / 10000)), 0) from closed),
      'receivedCents', (select coalesce(sum(amount), 0) from received),
      'costCents', (select coalesce(sum(qty * cost), 0) from sold),
      'itemsSold', (select coalesce(sum(qty), 0) from sold),
      'closedComandas', (select count(*) from closed where kind = 'regular'),
      'quickSales', (select count(*) from closed where kind = 'quick'),
      'canceledComandas', (select count(*) from com, w where com.status = 'canceled' and com.canceled_at >= w.f and com.canceled_at < w.t),
      'canceledCents', (select coalesce(sum(qty * price), 0) from items, w where status = 'canceled' and not staff and canceled_at >= w.f and canceled_at < w.t),
      'reversedCents', (select coalesce(sum(amount), 0) from pays, w where status <> 'active' and reversed_at >= w.f and reversed_at < w.t),
      'staffCents', (select coalesce(sum(qty * price), 0) from items, w where status = 'active' and staff and created_at >= w.f and created_at < w.t),
      'lossesCents', (select coalesce(sum(cost), 0) from loss),
      'stillOpen', (select count(*) from chosen where open_in),
      'stillOpenCents', (select coalesce(sum(s.subtotal), 0) from chosen c join sub s on s.id = c.id where c.open_in)
    ),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'totalCents', total) order by total desc, method)
      from (select method, count(*) as n, sum(amount) as total from received group by method) x), '[]'::jsonb),
    'byHour', coalesce((select jsonb_agg(jsonb_build_object('hour', hour, 'totalCents', total) order by (hour + 19) % 24)
      from (select extract(hour from created_at at time zone 'America/Sao_Paulo')::int as hour, sum(qty * price) as total from sold group by 1) x), '[]'::jsonb),
    'byDay', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'totalCents', total, 'costCents', cost) order by day)
      from (select to_char((created_at at time zone 'America/Sao_Paulo') - interval '5 hours', 'YYYY-MM-DD') as day,
                   sum(qty * price) as total, sum(qty * cost) as cost from sold group by 1) x), '[]'::jsonb),
    'byCategory', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'qty', qty, 'totalCents', total, 'costCents', cost) order by total desc, category)
      from (select coalesce(c.data ->> 'name', 'Narguilé') as category, sum(s.qty) as qty, sum(s.qty * s.price) as total, sum(s.qty * s.cost) as cost
            from sold s left join rec c on c.entity = 'category' and c.id = s.category_id group by 1) x), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('name', product_name, 'presentation', presentation_name, 'qty', qty, 'totalCents', total, 'costCents', cost)
        order by total desc, qty desc, product_name)
      from (select product_name, presentation_name, sum(qty) as qty, sum(qty * price) as total, sum(qty * cost) as cost from sold group by 1, 2) x), '[]'::jsonb),
    'byWaiter', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'orders', orders, 'totalCents', total) order by total desc, name)
      from (select coalesce(u.name, 'Sem nome') as name, count(distinct s.order_id) as orders, sum(s.qty * s.price) as total
            from sold s left join usr u on u.id = s.created_by group by s.created_by, u.name) x), '[]'::jsonb),
    'discounts', coalesce((select jsonb_agg(jsonb_build_object(
        'comanda', case when c.kind = 'quick' then 'Venda rápida ' || c.number else 'Comanda ' || coalesce(c.card_number, c.number) end,
        'customer', nullif(c.customer_name, ''), 'reason', c.discount_reason, 'discountCents', c.eff_discount,
        'closedAt', c.closed_at_txt, 'closedBy', u.name) order by c.closed_at)
      from closed c left join usr u on u.id = c.closed_by where c.discount > 0), '[]'::jsonb),
    'cancellations', coalesce((select jsonb_agg(jsonb_build_object('at', i.canceled_at_txt, 'product', i.product_name, 'qty', i.qty,
        'totalCents', i.qty * i.price, 'reason', i.cancel_reason, 'by', u.name) order by i.canceled_at)
      from items i cross join w left join usr u on u.id = i.canceled_by
      where i.status = 'canceled' and i.canceled_at >= w.f and i.canceled_at < w.t), '[]'::jsonb),
    'staffConsumption', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'items', n, 'valueCents', value, 'costCents', cost) order by value desc, name)
      from (select coalesce(u.name, c.customer_name, 'Funcionário') as name, sum(i.qty) as n, sum(i.qty * i.price) as value, sum(i.qty * i.cost) as cost
            from items i join com c on c.id = i.comanda_id left join usr u on u.id = c.staff_user_id, w
            where i.status = 'active' and i.staff and i.created_at >= w.f and i.created_at < w.t
            group by coalesce(c.staff_user_id::text, c.customer_name), coalesce(u.name, c.customer_name, 'Funcionário')) x), '[]'::jsonb),
    'cashSessions', coalesce((select jsonb_agg(jsonb_build_object(
        'number', (s.data ->> 'number')::int, 'status', s.data ->> 'status',
        'openedAt', s.data ->> 'opened_at', 'openedBy', uo.name, 'closedAt', s.data ->> 'closed_at', 'closedBy', uc.name,
        'openingCents', coalesce((s.data ->> 'opening_balance_cents')::bigint, 0),
        'expectedCents', case when s.data ->> 'status' = 'open'
          then coalesce((s.data ->> 'opening_balance_cents')::bigint, 0)
             + (select coalesce(sum(p.amount), 0) from pays p where p.session_id = s.id and p.status = 'active' and p.method = 'cash')
             + (select coalesce(sum(case when m.type = 'supply' then m.amount else -m.amount end), 0) from moves m where m.session_id = s.id)
          else (s.data ->> 'expected_cash_cents')::bigint end,
        'countedCents', (s.data ->> 'counted_cash_cents')::bigint, 'differenceCents', (s.data ->> 'difference_cents')::bigint)
        order by (s.data ->> 'opened_at')::timestamptz)
      from rec s cross join w left join usr uo on uo.id = (s.data ->> 'opened_by')::uuid left join usr uc on uc.id = (s.data ->> 'closed_by')::uuid
      where s.entity = 'cash_session' and (s.data ->> 'opened_at')::timestamptz >= w.f and (s.data ->> 'opened_at')::timestamptz < w.t), '[]'::jsonb),
    'cashMovements', coalesce((select jsonb_agg(jsonb_build_object('at', m.created_at_txt, 'type', case when m.type = 'supply' then 'supply' else 'withdrawal' end,
        'amountCents', m.amount, 'reason', m.reason, 'by', u.name) order by m.created_at)
      from moves m cross join w left join usr u on u.id = m.created_by where m.created_at >= w.f and m.created_at < w.t), '[]'::jsonb),
    'losses', coalesce((select jsonb_agg(jsonb_build_object('product', product,
        'reason', case reason when 'expired' then 'Vencimento' when 'broken' then 'Quebra' when 'spilled' then 'Derramamento'
          when 'missing' then 'Extravio' when 'spoiled' then 'Deterioração' when 'other' then 'Outros' else reason end,
        'count', cnt, 'costCents', cost) order by cost desc, product) from loss), '[]'::jsonb),
    'hookah', (select jsonb_build_object('sessions', sessions, 'totalCents', total) from hk)
  );
$$;

revoke execute on function public.rupbar_full_report(uuid, date, date) from public, anon;
grant execute on function public.rupbar_full_report(uuid, date, date) to authenticated;
