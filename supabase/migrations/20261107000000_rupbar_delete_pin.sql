-- RupBar 0.9: apagar item da comanda pela Lixeira do painel (com senha). O item
-- vira cancelado (nada some), e a Lixeira mostra o histórico. Aqui só expomos
-- quando/quem cancelou e um jeito de conferir a senha sem mandá-la ao navegador.
-- O apagar em si usa o comando comanda_item.cancel, que já é permitido. Só acrescenta.

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
  coalesce((data ->> 'staff')::int, 0) = 1 as staff,
  -- Colunas novas vão no fim (o Postgres não deixa inserir no meio de uma view).
  data ->> 'options_label' as options_label,
  (data ->> 'canceled_at')::timestamptz as canceled_at,
  (data ->> 'canceled_by')::uuid as canceled_by
from public.sync_records where entity = 'comanda_item' and not deleted;

revoke all on public.v_comanda_items from anon;
grant select on public.v_comanda_items to authenticated;

/**
 * Confere a senha da Lixeira sem devolver o valor dela ao navegador: só diz
 * sim/não. A senha vem do cadastro do bar sincronizado pelo PC (padrão 354500).
 * Só o proprietário do bar pode perguntar.
 */
create or replace function public.rupbar_verify_delete_pin(p_establishment_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pin text;
begin
  if not public.rupbar_is_owner(p_establishment_id) then
    raise exception 'Somente o proprietário' using errcode = '42501';
  end if;
  select coalesce(data ->> 'delete_pin', '354500') into v_pin
    from public.sync_records
    where establishment_id = p_establishment_id and entity = 'establishment' and not deleted
    limit 1;
  return coalesce(v_pin, '354500') = coalesce(p_pin, '');
end;
$$;

revoke all on function public.rupbar_verify_delete_pin(uuid, text) from anon;
grant execute on function public.rupbar_verify_delete_pin(uuid, text) to authenticated;
