-- RupBar 0.4: desconto só o proprietário dá. O funcionário pede no PC; o
-- pedido chega aqui (registro 'discount_request'), o proprietário aceita ou
-- recusa pelo painel e a resposta volta ao PC como comando. O proprietário
-- também dá desconto direto na comanda pelo painel. Só acrescenta.

-- O PC passa a enviar os pedidos de desconto.
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
    'hookah_consumption','user','purchase','discount_request'];
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

alter table public.remote_commands drop constraint if exists remote_commands_type_check;
alter table public.remote_commands add constraint remote_commands_type_check check (type in (
  'loss.register', 'comanda.open', 'order.create', 'comanda_item.cancel', 'cash.open', 'cash.close', 'user.remove', 'product.set_active',
  'comanda.discount', 'discount.approve', 'discount.reject'
));

/**
 * Ação do proprietário pelo painel. O PC valida tudo de novo (é a fonte da
 * verdade); aqui só se confere quem pede, o tipo e o tamanho do pedido.
 */
create or replace function public.rupbar_owner_command(p_establishment_id uuid, p_type text, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
begin
  if not public.rupbar_is_owner(p_establishment_id) then
    raise exception 'Somente o proprietário pode operar pelo painel' using errcode = '42501';
  end if;
  if p_type not in ('comanda.open', 'order.create', 'comanda_item.cancel', 'cash.open', 'cash.close', 'user.remove', 'product.set_active',
                    'comanda.discount', 'discount.approve', 'discount.reject') then
    raise exception 'Ação inválida' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 20000 then
    raise exception 'Dados inválidos' using errcode = '22023';
  end if;
  select coalesce(raw_user_meta_data ->> 'name', email) into v_name from auth.users where id = auth.uid();
  insert into public.remote_commands (establishment_id, type, payload, created_by)
  values (
    p_establishment_id, p_type,
    p_payload || jsonb_build_object('registeredByName', left(coalesce(v_name, 'Proprietário') || ' (painel online)', 80)),
    auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Pedidos de desconto para o proprietário responder.
create or replace view public.v_discount_requests with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'comanda_id')::uuid as comanda_id,
  data ->> 'requested_by_name' as requested_by_name,
  (data ->> 'discount_cents')::bigint as discount_cents,
  data ->> 'reason' as reason,
  (data ->> 'subtotal_cents')::bigint as subtotal_cents,
  (data ->> 'total_cents')::bigint as total_cents,
  (data ->> 'total_after_cents')::bigint as total_after_cents,
  data ->> 'status' as status,
  data ->> 'decided_by_name' as decided_by_name,
  (data ->> 'decided_at')::timestamptz as decided_at,
  data ->> 'decision_note' as decision_note,
  (data ->> 'created_at')::timestamptz as created_at
from public.sync_records where entity = 'discount_request' and not deleted;

revoke all on public.v_discount_requests from anon;
grant select on public.v_discount_requests to authenticated;
