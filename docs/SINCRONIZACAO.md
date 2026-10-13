# Sincronização PC ⇄ nuvem

## Visão geral

```
PC do bar                                         Supabase
───────────────────────────────────────────       ─────────────────────────────────
escrita em tabela sincronizada
  └─ gatilho → sync_outbox (mesma transação)
worker (a cada 5 s, backoff até 5 min)
  1. push   ─── rupbar_device_push ───────────►  upsert por versão em sync_records
  2. pull   ◄── rupbar_device_pull ────────────  comandos pendentes (perdas)
     aplica cada comando 1× (remote_commands_applied)
  3. ack    ─── rupbar_device_ack ────────────►  status: applied / conflict / rejected
  4. heartbeat ─ rupbar_device_heartbeat ─────►  last_sync_at, pendências, versão
```

## Outbox transacional

- Gatilhos `AFTER INSERT/UPDATE` nas tabelas sincronizadas inserem `(entity, entity_id)` em `sync_outbox` **na mesma transação** da alteração. Nenhum caminho de código consegue “esquecer” de enfileirar, e uma queda de energia nunca deixa a alteração sem registro na fila (ou vice-versa).
- Os gatilhos só atuam com a nuvem configurada (`meta.sync_enabled = '1'`). Ao conectar, um *snapshot* completo é enfileirado.
- No envio, registros repetidos da mesma entidade são agrupados e o **estado atual** da linha é enviado com `version = MAX(seq)` da outbox (sequência global monotônica).
- Após confirmação, removem-se apenas as entradas com `seq ≤ versão enviada`; alterações feitas durante o envio permanecem e seguem no próximo ciclo.

## Idempotência e ordem

- A nuvem aceita uma versão apenas se for **maior** que a armazenada (`ON CONFLICT … WHERE version < excluded.version`). Reenvios e entregas atrasadas são inofensivos e são confirmados (ack) mesmo sem alterar nada.
- Identificadores são UUID v7 gerados no PC: não há colisão nem necessidade de mapear IDs.

## Comandos remotos (perdas registradas no site)

1. O proprietário registra a perda no painel → `rupbar_owner_register_loss` valida dono, produto, quantidade, unidade e motivo, e cria `remote_commands` com status `pending` (“Aguardando aplicação”). **O saldo na nuvem não é alterado.**
2. O PC busca comandos (`pending`/`delivered`) — entregues com `FOR UPDATE SKIP LOCKED`.
3. O PC aplica dentro de uma transação e grava o resultado em `remote_commands_applied` (chave = id do comando). Se o comando chegar de novo (ack perdido), o resultado gravado é reutilizado: **nunca aplica duas vezes**.
4. Validação contra o estoque atual:
   - saldo suficiente → movimento de perda, status `applied`;
   - saldo insuficiente → nada é baixado; perda registrada como **conflito** para o proprietário resolver no PC (“aplicar até o saldo disponível”, “aplicar total” após corrigir o saldo, ou “rejeitar”);
   - produto inexistente/sem controle ou dados inválidos → `rejected`.
5. O PC confirma (`ack`); o painel mostra o resultado. A perda aplicada e o novo saldo chegam pela réplica normal.
6. Enquanto não entregue, o proprietário pode cancelar o comando.

## Estados exibidos

| Estado | Quando |
|---|---|
| Sincronizado | Último ciclo concluído e outbox vazia |
| Sincronizando | Ciclo em andamento |
| Pendências | Há registros na outbox entre ciclos |
| Sem internet | Falha de rede (erro de conexão/timeout) |
| Erro de sincronização | A nuvem respondeu erro (ex.: credencial revogada) |
| Nuvem não configurada | PC ainda não conectado |

No painel: horário da última sincronização e aviso de **dados desatualizados** após 15 minutos sem contato.

## Minimização de dados (LGPD)

Serializadores por entidade (`apps/server/src/db/sync-tables.ts`) removem antes do envio: CPF e telefone de clientes (enviando apenas `has_cpf`/`has_phone`), hashes de senha, e-mails e permissões de funcionários, identificadores de idempotência. Comprovantes não são enviados.

## Credenciais

- O PC é registrado uma vez com o login do proprietário; recebe `device_id` + segredo aleatório de 244 bits. A nuvem guarda apenas o SHA-256 do segredo; o PC o guarda cifrado (AES-256-GCM).
- Registrar outro PC revoga o anterior (um único PC autoridade por estabelecimento). O proprietário pode revogar pelo painel.

## Testes

- `apps/server/test/remote.test.ts`: nuvem simulada (offline, reentrega, conflito, rejeição, minimização).
- `supabase/test/migration.test.ts`: SQL real (PGlite) — RLS, credenciais, versões, fila.
- `supabase/test/contract.test.ts`: o motor de sincronização real do servidor contra as funções SQL reais.
