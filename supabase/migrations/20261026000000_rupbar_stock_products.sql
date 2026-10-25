-- RupBar 0.8: estoque e produtos pelo painel. O proprietário dá entrada,
-- corrige o saldo (contagem) e altera preços e estoque mínimo; o PC aplica.
-- O site também passa a ver o nome da unidade (lata, long neck). Só acrescenta.

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
  (data ->> 'updated_at')::timestamptz as updated_at,
  data ->> 'unit_label' as unit_label
from public.sync_records where entity = 'product' and not deleted;

alter table public.remote_commands drop constraint if exists remote_commands_type_check;
alter table public.remote_commands add constraint remote_commands_type_check check (type in (
  'loss.register', 'comanda.open', 'order.create', 'comanda_item.cancel', 'cash.open', 'cash.close', 'user.remove', 'product.set_active',
  'comanda.discount', 'discount.approve', 'discount.reject', 'comanda.close', 'stock.entry', 'stock.adjust', 'product.update'
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
                    'comanda.discount', 'discount.approve', 'discount.reject', 'comanda.close', 'stock.entry', 'stock.adjust', 'product.update') then
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

revoke all on public.v_products from anon;
grant select on public.v_products to authenticated;
