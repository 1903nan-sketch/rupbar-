-- Descontos no painel: o motivo do desconto e quem encerrou a comanda. O PC já
-- envia os dois; só faltavam na visão. Só acrescenta (colunas novas no fim).

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
  data ->> 'cancel_reason' as cancel_reason,
  (data ->> 'card_number')::int as card_number,
  coalesce(data ->> 'kind', 'regular') as kind,
  data ->> 'discount_reason' as discount_reason,
  (data ->> 'closed_by')::uuid as closed_by
from public.sync_records where entity = 'comanda' and not deleted;
