-- Caixa aberto no painel: o site calcula o dinheiro esperado na gaveta como o
-- PC (troco + dinheiro recebido + suprimentos − sangrias). Sangria/suprimento
-- anulado no PC fica com status 'voided' e não pode entrar na conta. Só
-- acrescenta (coluna nova no fim da visão).

create or replace view public.v_cash_movements with (security_invoker = true) as
select establishment_id, id,
  (data ->> 'session_id')::uuid as session_id,
  data ->> 'type' as type,
  (data ->> 'amount_cents')::bigint as amount_cents,
  data ->> 'reason' as reason,
  (data ->> 'attachment_id') is not null as has_attachment,
  (data ->> 'created_by')::uuid as created_by,
  (data ->> 'created_at')::timestamptz as created_at,
  coalesce(data ->> 'status', 'active') as status
from public.sync_records where entity = 'cash_movement' and not deleted;
