-- RupBar 0.3: o painel online também opera o bar — abrir comanda, lançar e
-- tirar item, abrir e fechar o caixa, excluir funcionário e tirar produto da
-- venda. Cada ação vira um comando que o PC do bar confere, aplica uma única
-- vez e confirma (ou recusa com o motivo). Só acrescenta; nada é apagado.

alter table public.remote_commands drop constraint if exists remote_commands_type_check;
alter table public.remote_commands add constraint remote_commands_type_check check (type in (
  'loss.register', 'comanda.open', 'order.create', 'comanda_item.cancel', 'cash.open', 'cash.close', 'user.remove', 'product.set_active'
));

-- Apresentações à venda (nome, preço), para lançar itens pelo painel.
create or replace view public.v_presentations with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'product_id')::uuid as product_id,
  data ->> 'name' as name,
  (data ->> 'price_cents')::bigint as price_cents,
  coalesce((data ->> 'menu_visible')::int, 1) = 1 as menu_visible,
  coalesce((data ->> 'active')::int, 1) = 1 as active,
  coalesce((data ->> 'sort_order')::int, 0) as sort_order
from public.sync_records where entity = 'presentation' and not deleted;

revoke all on public.v_presentations from anon;
grant select on public.v_presentations to authenticated;

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
  if p_type not in ('comanda.open', 'order.create', 'comanda_item.cancel', 'cash.open', 'cash.close', 'user.remove', 'product.set_active') then
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

revoke execute on function public.rupbar_owner_command(uuid, text, jsonb) from public, anon;
grant execute on function public.rupbar_owner_command(uuid, text, jsonb) to authenticated;
