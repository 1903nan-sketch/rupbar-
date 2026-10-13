-- RupBar 0.2: cartões numerados, venda rápida e narguilé por item.
-- Só acrescenta colunas ao fim das visões (create or replace mantém permissões).

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
  coalesce(data ->> 'kind', 'regular') as kind
from public.sync_records where entity = 'comanda' and not deleted;

create or replace view public.v_hookah_sessions with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'hookah_id')::uuid as hookah_id,
  data ->> 'status' as status,
  (data ->> 'charge_cents')::bigint as charge_cents,
  (data ->> 'rosh_count')::int as rosh_count,
  (data ->> 'started_at')::timestamptz as started_at,
  (data ->> 'ended_at')::timestamptz as ended_at,
  coalesce(data ->> 'mode', 'legacy') as mode,
  data ->> 'customer_name' as customer_name
from public.sync_records where entity = 'hookah_session' and not deleted;
