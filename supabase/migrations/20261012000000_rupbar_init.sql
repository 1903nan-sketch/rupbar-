-- =============================================================================
-- RupBar — esquema da nuvem (Supabase / Postgres 15+)
--
-- Modelo: o PC do bar é a AUTORIDADE operacional. A nuvem guarda uma réplica
-- somente-leitura dos dados (sync_records) e uma fila de comandos
-- administrativos (remote_commands) que o PC aplica e confirma.
--
--  * O PC autentica com uma credencial própria de dispositivo (id + segredo),
--    nunca com a senha do proprietário. Funções rupbar_device_* validam o
--    segredo (hash SHA-256) e são as únicas que escrevem em sync_records.
--  * O proprietário (Supabase Auth) só LÊ os dados do seu estabelecimento
--    (RLS) e só cria comandos por funções que validam o conteúdo.
--  * Upsert por versão: a nuvem aceita apenas versões maiores que a guardada
--    → reenvios e entregas fora de ordem são idempotentes.
-- =============================================================================

-- ----------------------------------------------------------------- tabelas

create table if not exists public.establishments (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  trade_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists establishments_owner on public.establishments (owner_id);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  name text not null,
  secret_hash text not null,
  app_version text,
  pending_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  revoked_at timestamptz
);
create index if not exists devices_establishment on public.devices (establishment_id);

create table if not exists public.sync_records (
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  entity text not null,
  id uuid not null,
  version bigint not null,
  deleted boolean not null default false,
  data jsonb not null,
  source_updated_at timestamptz,
  received_at timestamptz not null default now(),
  primary key (establishment_id, entity, id)
);
create index if not exists sync_records_entity on public.sync_records (establishment_id, entity);
create index if not exists sync_records_created on public.sync_records (establishment_id, entity, ((data ->> 'created_at')));

create table if not exists public.remote_commands (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  type text not null check (type in ('loss.register')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'applied', 'rejected', 'conflict', 'canceled')),
  result jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  applied_at timestamptz,
  acked_at timestamptz
);
create index if not exists remote_commands_queue on public.remote_commands (establishment_id, status, created_at);

-- ----------------------------------------------------------------- RLS

alter table public.establishments enable row level security;
alter table public.devices enable row level security;
alter table public.sync_records enable row level security;
alter table public.remote_commands enable row level security;

create or replace function public.rupbar_is_owner(p_establishment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.establishments e
    where e.id = p_establishment_id and e.owner_id = auth.uid()
  );
$$;

drop policy if exists establishments_owner_read on public.establishments;
create policy establishments_owner_read on public.establishments
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists devices_owner_read on public.devices;
create policy devices_owner_read on public.devices
  for select to authenticated using (public.rupbar_is_owner(establishment_id));

drop policy if exists sync_records_owner_read on public.sync_records;
create policy sync_records_owner_read on public.sync_records
  for select to authenticated using (public.rupbar_is_owner(establishment_id));

drop policy if exists remote_commands_owner_read on public.remote_commands;
create policy remote_commands_owner_read on public.remote_commands
  for select to authenticated using (public.rupbar_is_owner(establishment_id));

-- Nenhuma política de escrita: inserções/alterações somente pelas funções abaixo.
revoke insert, update, delete on public.establishments, public.devices, public.sync_records, public.remote_commands from anon, authenticated;
revoke select on public.devices from anon;
grant select on public.establishments, public.devices, public.sync_records, public.remote_commands to authenticated;

-- ------------------------------------------------------- dispositivo (PC)

/** Registra o PC do bar (chamado com o login do proprietário). Revoga PCs anteriores. */
create or replace function public.rupbar_register_device(p_establishment_id uuid, p_device_name text, p_trade_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_uid uuid := auth.uid();
  v_secret text;
  v_device uuid;
begin
  if v_uid is null then
    raise exception 'Autenticação necessária' using errcode = '28000';
  end if;
  select owner_id into v_owner from public.establishments where id = p_establishment_id;
  if v_owner is null then
    insert into public.establishments (id, owner_id, trade_name) values (p_establishment_id, v_uid, left(coalesce(p_trade_name, 'RupBar'), 120));
  elsif v_owner <> v_uid then
    raise exception 'Este estabelecimento pertence a outra conta' using errcode = '42501';
  else
    update public.establishments set trade_name = left(coalesce(p_trade_name, trade_name), 120), updated_at = now() where id = p_establishment_id;
  end if;

  -- Um único PC autoridade por estabelecimento.
  update public.devices set revoked_at = now() where establishment_id = p_establishment_id and revoked_at is null;

  -- 244 bits de aleatoriedade forte (gen_random_uuid usa pg_strong_random).
  v_secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.devices (establishment_id, name, secret_hash)
  values (p_establishment_id, left(coalesce(p_device_name, 'PC do bar'), 60), encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'))
  returning id into v_device;

  return jsonb_build_object('device_id', v_device, 'device_secret', v_secret, 'establishment_id', p_establishment_id);
end;
$$;

/** Valida a credencial do dispositivo e devolve o estabelecimento. Uso interno. */
create or replace function public.rupbar_device_auth(p_device_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est uuid;
begin
  select establishment_id into v_est from public.devices
  where id = p_device_id and revoked_at is null and secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
  if v_est is null then
    raise exception 'Dispositivo não autorizado' using errcode = '28000';
  end if;
  return v_est;
end;
$$;

/**
 * Recebe registros da outbox do PC. Upsert idempotente por versão.
 * Retorna os outboxIds aceitos (inclusive os já presentes com versão ≥).
 */
create or replace function public.rupbar_device_push(p_device_id uuid, p_secret text, p_records jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est uuid := public.rupbar_device_auth(p_device_id, p_secret);
  r jsonb;
  v_acked jsonb := '[]'::jsonb;
  v_rejected jsonb := '[]'::jsonb;
  v_allowed text[] := array['establishment','category','product','presentation','supplier','stock_movement','stock_alert',
    'comanda','comanda_item','order','payment','cash_session','cash_movement','loss','hookah','hookah_session',
    'hookah_consumption','user','purchase'];
begin
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
    raise exception 'Lote inválido' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_records) loop
    if not (r ->> 'entity' = any (v_allowed)) or (r ->> 'id') is null or (r ->> 'version') is null then
      v_rejected := v_rejected || jsonb_build_object('outboxId', r ->> 'outboxId', 'reason', 'registro inválido');
      continue;
    end if;
    insert into public.sync_records as s (establishment_id, entity, id, version, deleted, data, source_updated_at, received_at)
    values (
      v_est, r ->> 'entity', (r ->> 'id')::uuid, (r ->> 'version')::bigint, coalesce((r ->> 'deleted')::boolean, false),
      coalesce(r -> 'data', '{}'::jsonb), nullif(r ->> 'updatedAt', '')::timestamptz, now()
    )
    on conflict (establishment_id, entity, id) do update
      set version = excluded.version, deleted = excluded.deleted, data = excluded.data,
          source_updated_at = excluded.source_updated_at, received_at = now()
      where s.version < excluded.version;
    v_acked := v_acked || to_jsonb(r ->> 'outboxId');
  end loop;
  update public.devices set last_sync_at = now(), last_seen_at = now() where id = p_device_id;
  return jsonb_build_object('acked', v_acked, 'rejected', v_rejected);
end;
$$;

/** Entrega ao PC os comandos pendentes (perdas registradas no site). */
create or replace function public.rupbar_device_pull(p_device_id uuid, p_secret text, p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est uuid := public.rupbar_device_auth(p_device_id, p_secret);
  v_out jsonb;
begin
  with picked as (
    select id from public.remote_commands
    where establishment_id = v_est and status in ('pending', 'delivered')
    order by created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update skip locked
  ), marked as (
    update public.remote_commands c
    set status = 'delivered', delivered_at = coalesce(c.delivered_at, now())
    from picked where c.id = picked.id
    returning c.id, c.type, c.payload, c.created_at, c.created_by
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'type', type, 'payload', payload, 'createdAt', created_at, 'createdBy', created_by
  ) order by created_at), '[]'::jsonb) into v_out from marked;
  update public.devices set last_seen_at = now() where id = p_device_id;
  return v_out;
end;
$$;

/** Confirmação do PC: resultado da aplicação de cada comando. */
create or replace function public.rupbar_device_ack(p_device_id uuid, p_secret text, p_results jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est uuid := public.rupbar_device_auth(p_device_id, p_secret);
  r jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if r ->> 'status' not in ('applied', 'rejected', 'conflict') then
      continue;
    end if;
    update public.remote_commands
    set status = r ->> 'status', result = r, applied_at = nullif(r ->> 'appliedAt', '')::timestamptz, acked_at = now()
    where id = (r ->> 'commandId')::uuid and establishment_id = v_est and status in ('pending', 'delivered', 'applied', 'rejected', 'conflict');
  end loop;
end;
$$;

create or replace function public.rupbar_device_heartbeat(p_device_id uuid, p_secret text, p_status jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est uuid := public.rupbar_device_auth(p_device_id, p_secret);
begin
  update public.devices
  set last_seen_at = now(), last_sync_at = now(),
      pending_count = coalesce((p_status ->> 'pending')::integer, 0),
      app_version = left(p_status ->> 'version', 40)
  where id = p_device_id and establishment_id = v_est;
end;
$$;

-- ------------------------------------------------------------- proprietário

/**
 * Perda registrada pelo proprietário no painel online. Fica "Aguardando
 * aplicação" até o PC confirmar; o saldo operacional NÃO é alterado aqui.
 */
create or replace function public.rupbar_owner_register_loss(
  p_establishment_id uuid, p_product_id uuid, p_qty bigint, p_unit text, p_reason text, p_occurred_at timestamptz, p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product jsonb;
  v_id uuid;
  v_name text;
begin
  if not public.rupbar_is_owner(p_establishment_id) then
    raise exception 'Somente o proprietário pode registrar perdas' using errcode = '42501';
  end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000000000 then
    raise exception 'Quantidade inválida' using errcode = '22023';
  end if;
  if p_unit not in ('un', 'ml', 'l', 'g', 'kg') then
    raise exception 'Unidade inválida' using errcode = '22023';
  end if;
  if p_reason not in ('expired', 'broken', 'spilled', 'missing', 'spoiled', 'other') then
    raise exception 'Motivo inválido' using errcode = '22023';
  end if;
  select data into v_product from public.sync_records
  where establishment_id = p_establishment_id and entity = 'product' and id = p_product_id and not deleted;
  if v_product is null or coalesce((v_product ->> 'stock_tracked')::int, 0) <> 1 then
    raise exception 'Produto não encontrado ou sem controle de estoque' using errcode = '22023';
  end if;
  select coalesce(raw_user_meta_data ->> 'name', email) into v_name from auth.users where id = auth.uid();
  insert into public.remote_commands (establishment_id, type, payload, created_by)
  values (
    p_establishment_id, 'loss.register',
    jsonb_build_object(
      'productId', p_product_id, 'qty', p_qty, 'unit', p_unit, 'reason', p_reason,
      'occurredAt', to_char(coalesce(p_occurred_at, now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'notes', nullif(left(coalesce(p_notes, ''), 400), ''),
      'registeredByName', left(coalesce(v_name, 'Proprietário') || ' (painel online)', 80)
    ),
    auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

/** Cancela um comando que o PC ainda não recebeu. */
create or replace function public.rupbar_owner_cancel_command(p_command_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est uuid;
  v_status text;
begin
  select establishment_id, status into v_est, v_status from public.remote_commands where id = p_command_id for update;
  if v_est is null or not public.rupbar_is_owner(v_est) then
    raise exception 'Comando não encontrado' using errcode = '42501';
  end if;
  if v_status <> 'pending' then
    return false;
  end if;
  update public.remote_commands set status = 'canceled', result = jsonb_build_object('message', 'Cancelado pelo proprietário') where id = p_command_id;
  return true;
end;
$$;

create or replace function public.rupbar_owner_revoke_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_est uuid;
begin
  select establishment_id into v_est from public.devices where id = p_device_id;
  if v_est is null or not public.rupbar_is_owner(v_est) then
    raise exception 'Dispositivo não encontrado' using errcode = '42501';
  end if;
  update public.devices set revoked_at = now() where id = p_device_id and revoked_at is null;
end;
$$;

-- --------------------------------------------- visões tipadas (relatórios)
-- security_invoker: as visões respeitam o RLS de quem consulta.

create or replace view public.v_products with (security_invoker = true) as
select establishment_id, id,
  data ->> 'name' as name,
  (data ->> 'category_id')::uuid as category_id,
  data ->> 'measure' as measure,
  (data ->> 'stock_qty')::bigint as stock_qty,
  (data ->> 'min_stock')::bigint as min_stock,
  (data ->> 'package_qty')::bigint as package_qty,
  data ->> 'package_label' as package_label,
  (data ->> 'unit_cost_e4')::bigint as unit_cost_e4,
  (data ->> 'stock_tracked')::int = 1 as stock_tracked,
  (data ->> 'active')::int = 1 as active,
  (data ->> 'updated_at')::timestamptz as updated_at
from public.sync_records where entity = 'product' and not deleted;

create or replace view public.v_categories with (security_invoker = true) as
select establishment_id, id, data ->> 'name' as name, data ->> 'station' as station, (data ->> 'sort_order')::int as sort_order
from public.sync_records where entity = 'category' and not deleted;

create or replace view public.v_comandas with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'number')::int as number,
  data ->> 'customer_name' as customer_name,
  data ->> 'table_label' as table_label,
  data ->> 'status' as status,
  (data ->> 'discount_cents')::bigint as discount_cents,
  (data ->> 'service_fee_bp')::int as service_fee_bp,
  (data ->> 'opened_at')::timestamptz as opened_at,
  (data ->> 'closed_at')::timestamptz as closed_at,
  data ->> 'cancel_reason' as cancel_reason
from public.sync_records where entity = 'comanda' and not deleted;

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
  (data ->> 'created_at')::timestamptz as created_at
from public.sync_records where entity = 'comanda_item' and not deleted;

create or replace view public.v_payments with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'comanda_id')::uuid as comanda_id,
  (data ->> 'cash_session_id')::uuid as cash_session_id,
  data ->> 'method' as method,
  (data ->> 'amount_cents')::bigint as amount_cents,
  data ->> 'status' as status,
  (data ->> 'created_at')::timestamptz as created_at
from public.sync_records where entity = 'payment' and not deleted;

create or replace view public.v_cash_sessions with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'number')::int as number,
  data ->> 'status' as status,
  (data ->> 'opened_by')::uuid as opened_by,
  (data ->> 'closed_by')::uuid as closed_by,
  (data ->> 'opened_at')::timestamptz as opened_at,
  (data ->> 'closed_at')::timestamptz as closed_at,
  (data ->> 'opening_balance_cents')::bigint as opening_balance_cents,
  (data ->> 'expected_cash_cents')::bigint as expected_cash_cents,
  (data ->> 'counted_cash_cents')::bigint as counted_cash_cents,
  (data ->> 'difference_cents')::bigint as difference_cents,
  case when data ->> 'summary_json' is null then null else (data ->> 'summary_json')::jsonb end as summary
from public.sync_records where entity = 'cash_session' and not deleted;

create or replace view public.v_cash_movements with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'session_id')::uuid as session_id,
  data ->> 'type' as type,
  (data ->> 'amount_cents')::bigint as amount_cents,
  data ->> 'reason' as reason,
  (data ->> 'attachment_id') is not null as has_attachment,
  (data ->> 'created_by')::uuid as created_by,
  (data ->> 'created_at')::timestamptz as created_at
from public.sync_records where entity = 'cash_movement' and not deleted;

create or replace view public.v_losses with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'product_id')::uuid as product_id,
  (data ->> 'qty')::bigint as qty,
  (data ->> 'applied_qty')::bigint as applied_qty,
  data ->> 'unit' as unit,
  data ->> 'reason' as reason,
  data ->> 'notes' as notes,
  data ->> 'source' as source,
  data ->> 'status' as status,
  (data ->> 'cost_cents')::bigint as cost_cents,
  (data ->> 'remote_command_id')::uuid as remote_command_id,
  data ->> 'registered_by_name' as registered_by_name,
  data ->> 'resolution_note' as resolution_note,
  (data ->> 'occurred_at')::timestamptz as occurred_at
from public.sync_records where entity = 'loss' and not deleted;

create or replace view public.v_stock_alerts with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'product_id')::uuid as product_id,
  data ->> 'status' as status,
  (data ->> 'stock_qty')::bigint as stock_qty,
  (data ->> 'min_stock')::bigint as min_stock,
  (data ->> 'created_at')::timestamptz as created_at
from public.sync_records where entity = 'stock_alert' and not deleted;

create or replace view public.v_hookah_sessions with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'hookah_id')::uuid as hookah_id,
  data ->> 'status' as status,
  (data ->> 'charge_cents')::bigint as charge_cents,
  (data ->> 'rosh_count')::int as rosh_count,
  (data ->> 'started_at')::timestamptz as started_at,
  (data ->> 'ended_at')::timestamptz as ended_at
from public.sync_records where entity = 'hookah_session' and not deleted;

create or replace view public.v_users with (security_invoker = true) as
select establishment_id, id, data ->> 'name' as name, data ->> 'role_name' as role_name, data ->> 'status' as status
from public.sync_records where entity = 'user' and not deleted;

-- ---------------------------------------------------- relatórios agregados
-- Funções security invoker: respeitam o RLS do proprietário.

create or replace function public.rupbar_sales_summary(p_establishment_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
set search_path = public
as $$
  with items as (
    select * from public.v_comanda_items
    where establishment_id = p_establishment_id and status = 'active' and created_at >= p_from and created_at < p_to
  ), pays as (
    select * from public.v_payments
    where establishment_id = p_establishment_id and status = 'active' and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'grossCents', coalesce((select sum(quantity * unit_price_cents) from items), 0),
    'costCents', coalesce((select sum(quantity * unit_cost_cents) from items), 0),
    'itemsSold', coalesce((select sum(quantity) from items), 0),
    'receivedCents', coalesce((select sum(amount_cents) from pays), 0),
    'closedComandas', (select count(*) from public.v_comandas where establishment_id = p_establishment_id and status = 'closed' and closed_at >= p_from and closed_at < p_to),
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
      and i.created_at >= p_from and i.created_at < p_to
    where p.establishment_id = p_establishment_id and p.id = any (p_product_ids)
    group by p.establishment_id, p.id, p.name
  ) x;
$$;

create or replace function public.rupbar_losses_report(p_establishment_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
set search_path = public
as $$
  with l as (
    select l.*, p.name as product_name, p.measure, coalesce(c.name, '—') as category
    from public.v_losses l
    join public.v_products p on p.id = l.product_id and p.establishment_id = l.establishment_id
    left join public.v_categories c on c.id = p.category_id and c.establishment_id = l.establishment_id
    where l.establishment_id = p_establishment_id and l.status = 'applied' and l.occurred_at >= p_from and l.occurred_at < p_to
  )
  select jsonb_build_object(
    'totalCostCents', coalesce((select sum(cost_cents) from l), 0),
    'byProduct', coalesce((select jsonb_agg(x order by x.cost_cents desc) from (
      select product_id, product_name as name, measure, category, count(*) as count, sum(applied_qty) as qty, sum(cost_cents) as cost_cents
      from l group by product_id, product_name, measure, category) x), '[]'::jsonb),
    'byCategory', coalesce((select jsonb_agg(x order by x.cost_cents desc) from (
      select category, count(*) as count, sum(cost_cents) as cost_cents from l group by category) x), '[]'::jsonb),
    'byReason', coalesce((select jsonb_agg(x order by x.cost_cents desc) from (
      select reason, count(*) as count, sum(cost_cents) as cost_cents from l group by reason) x), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------- permissões

revoke all on function public.rupbar_device_auth(uuid, text) from public, anon, authenticated;
grant execute on function public.rupbar_register_device(uuid, text, text) to authenticated;
grant execute on function public.rupbar_device_push(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.rupbar_device_pull(uuid, text, integer) to anon, authenticated;
grant execute on function public.rupbar_device_ack(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.rupbar_device_heartbeat(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.rupbar_owner_register_loss(uuid, uuid, bigint, text, text, timestamptz, text) to authenticated;
grant execute on function public.rupbar_owner_cancel_command(uuid) to authenticated;
grant execute on function public.rupbar_owner_revoke_device(uuid) to authenticated;
grant execute on function public.rupbar_sales_summary(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.rupbar_product_comparison(uuid, timestamptz, timestamptz, uuid[]) to authenticated;
grant execute on function public.rupbar_losses_report(uuid, timestamptz, timestamptz) to authenticated;
grant select on public.v_products, public.v_categories, public.v_comandas, public.v_comanda_items, public.v_payments,
  public.v_cash_sessions, public.v_cash_movements, public.v_losses, public.v_stock_alerts, public.v_hookah_sessions, public.v_users
  to authenticated;

-- Tempo real no painel: mudanças na fila de comandos e nos dispositivos.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.remote_commands, public.devices;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
