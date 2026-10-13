# Arquitetura do RupBar

## Princípios

1. **O PC do bar é a autoridade operacional.** Estoque, comandas, caixa e perdas são decididos no PC. A nuvem é réplica de leitura + fila de comandos.
2. **Offline-first.** Nenhuma operação do bar depende de internet, CDN ou serviço externo.
3. **Uma regra, um lugar.** Regras numéricas e de permissão ficam em `packages/core` e são usadas pelo servidor, pela interface e pelo painel.
4. **O backend valida tudo.** A interface apenas esconde o que o usuário não pode fazer; cada rota verifica permissões e valida a entrada (zod).

## Decisão: servidor em Node.js + Tauri só como janela

O prompt pede Tauri + React + TypeScript e permite Node.js “desde que não comprometa a leveza”. A escolha foi:

| Peça | Tecnologia | Por quê |
|---|---|---|
| Janela do Windows | **Tauri v2** (Rust + WebView2) | Executável de poucos MB que usa o WebView2 já presente no Windows 10/11 (sem embutir um navegador como o Electron). |
| Servidor local | **Node.js 22 + Fastify + `node:sqlite`** | Compartilha 100% das regras de domínio em TypeScript com a interface e o painel (dinheiro, unidades, permissões). `node:sqlite` é embutido no Node: nenhum módulo nativo para compilar no Windows do cliente. O bundle do servidor é **um único arquivo de 1,2 MB**; medido ~76 MB de RAM em uso. O instalador completo inclui o `node.exe` oficial (verificado por SHA-256). |
| Serviço do Windows | **`rupbar-service.exe` (Rust, ~400 KB)** | O Node não sabe falar com o Gerenciador de Serviços do Windows. Um supervisor nativo mínimo registra o serviço, reinicia o servidor se ele cair (backoff até 30 s), faz parada graciosa e configura firewall e permissões. |

Alternativa considerada: servidor inteiro em Rust dentro do Tauri. Seria mais leve (~20 MB de RAM), mas duplicaria todas as regras de negócio em duas linguagens (Rust no PC, TypeScript no painel e nos celulares) — maior risco de divergência em cálculos de estoque e caixa. Também acoplaria a disponibilidade da rede à janela aberta. A separação **janela ≠ servidor** garante que celulares, cozinha e TV continuam funcionando com a janela fechada, minimizada ou travada.

```
rupbar-service.exe (serviço, LocalSystem, início automático)
  └─ node.exe server.cjs --data-dir C:\ProgramData\RupBar --port 7420
        ├─ HTTP/WebSocket :7420 (interface, API, tempo real)
        ├─ mDNS rupbar.local (UDP 5353)
        ├─ workers: impressão, WhatsApp, sincronização, detecção de IP, backup diário
        └─ SQLite (WAL, synchronous=FULL) — rupbar.db
RupBar.exe (Tauri) → tela local de inicialização → http://127.0.0.1:7420
```

## Modelo de dados (resumo)

- **IDs**: UUID v7 gerados no dispositivo (ordenáveis, sem colisão offline).
- **Dinheiro**: centavos inteiros. **Quantidades**: milésimos da unidade-base — ml, g ou un. 30 ml = `30000`, 1 L = `1000000`, 0,5 g = `500`.
- **Custo**: `unit_cost_e4` = centavos por unidade-base × 10⁴ (whisky de R$ 120/L = 12 ¢/ml = `120000`). Custo médio ponderado nas entradas.
- **Cadastro único**: `products` (estoque) + `presentations` (preço de venda) + `presentation_components` (ficha técnica). Uma dose de 50 ml é uma apresentação que consome 50 ml do próprio produto; um hambúrguer consome pão, carne e queijo; uma caipirinha consome cachaça e limão.
- **Movimentações imutáveis**: `stock_movements`, `cash_movements`, `payments` e `audit_log` têm gatilhos que proíbem alteração/remoção. Correções geram estornos.
- **Baixa única**: índice único `(ref_type, ref_id, product_id, type)` em `stock_movements` impede descontar duas vezes o mesmo item.
- **Concorrência de comandas**: escrita serializada no SQLite (BEGIN IMMEDIATE) + controle otimista (`version`) em operações não comutativas (encerrar, transferir, desconto, cancelar). Lançar itens é comutativo e não exige versão.
- **Pedidos idempotentes**: `orders.client_request_id` único, gerado no celular; reenviar o mesmo pedido devolve o mesmo resultado.

## Tempo real

WebSocket `/ws` autenticado pelo cookie de sessão. Os eventos são **avisos** (“comanda X mudou”, “pedido novo”), nunca dados: o cliente recarrega pela API, que aplica permissões. Cada cliente só assina canais permitidos (a TV recebe apenas `tv`). Eventos são publicados somente após o COMMIT.

## Rede local

- Endereço preferencial calculado entre as interfaces privadas (ignora adaptadores virtuais/VPN).
- `rupbar.local` anunciado por mDNS.
- Mudança de IP detectada a cada 15 s → aviso no PC com o MAC para reserva de DHCP.
- Celulares guardam a interface em cache (service worker); se o endereço antigo não responde, testam `rupbar.local`, endereços conhecidos e a sub-rede `/24`, conferindo o `establishmentId` antes de redirecionar.

## Painel online

Next.js (App Router) com Supabase SSR. Leitura por visões `security_invoker` (RLS do proprietário); escrita apenas por RPCs que validam o conteúdo (`rupbar_owner_register_loss`, `rupbar_owner_cancel_command`, `rupbar_owner_revoke_device`).
