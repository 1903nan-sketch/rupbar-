# RupBar

**Sistema de gestão para bares, adegas, tabacarias e casas de narguilé — by Ruptix.**

O RupBar roda no **PC do bar** (Windows) e funciona **sem internet**: comandas, pedidos pelo celular dos garçons, cozinha e balcão, impressoras térmicas, TV de retirada com chamada por voz, caixa, estoque por mililitro e grama, perdas e narguilés. Quando há internet, os dados são enviados para o **painel online do proprietário**.

```
                 Rede Wi-Fi do bar (sem internet)                         Internet (opcional)
 ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
 │ Celulares e   │   │ Cozinha /    │   │ TV de         │
 │ tablets       │   │ balcão       │   │ retirada      │
 └──────┬────────┘   └──────┬───────┘   └──────┬────────┘
        │ HTTP + WebSocket   │                  │ (pareada por código)
 ┌──────▼────────────────────▼──────────────────▼───────┐        ┌─────────────────────┐
 │ PC do bar (Windows)                                   │  fila  │ Supabase (nuvem)    │
 │  ├─ Serviço "RupBar Server" (Node + SQLite)  ◄────────┼───────►│  réplica + comandos │
 │  │   API, tempo real, impressão ESC/POS, TV, sync     │ outbox │  RLS, RPCs          │
 │  └─ App RupBar (Tauri): janela + bandeja              │        └─────────┬───────────┘
 └───────────────────────────────────────────────────────┘                  │
                                                                  ┌─────────▼───────────┐
                                                                  │ Painel do           │
                                                                  │ proprietário        │
                                                                  │ (Next.js / Vercel)  │
                                                                  └─────────────────────┘
```

## Estrutura do repositório

| Pasta | O que é |
|---|---|
| `packages/core` | Regras de domínio compartilhadas: dinheiro em centavos, quantidades em milésimos de ml/g/un, custos por dose, permissões e perfis, validações (CPF/CNPJ/telefone) e mascaramento LGPD, cobrança de narguilé, fechamento de caixa, números por extenso para a voz da TV, codificador ESC/POS, protocolo de sincronização e esquemas de validação. |
| `apps/server` | Servidor local (Fastify + SQLite embutido do Node). API, WebSocket, impressão, TV, alertas, WhatsApp, sincronização, mDNS. |
| `apps/local-ui` | Interface React servida pelo próprio servidor: PC, celular do garçom (`/m`), produção (`/producao`) e TV (`/tv`). Sem CDN. |
| `apps/desktop` | Aplicativo Windows (Tauri v2): janela, bandeja e instalador NSIS que instala o serviço. |
| `apps/service-host` | `rupbar-service.exe` (Rust): serviço do Windows que supervisiona o servidor (reinício automático, parada graciosa, firewall). |
| `apps/owner-panel` | Painel online do proprietário (Next.js + Supabase Auth), para a Vercel. |
| `supabase` | Migrações da nuvem (tabelas, RLS, RPCs) + testes em Postgres real (PGlite). |
| `tests/e2e` | Teste ponta a ponta no Chromium. |
| `docs` | [Arquitetura](docs/ARQUITETURA.md) · [Sincronização](docs/SINCRONIZACAO.md) · [Segurança e LGPD](docs/SEGURANCA-LGPD.md) · [Implantação e operação](docs/IMPLANTACAO.md) |

## Desenvolvimento

Requisitos: Node.js 22.13+ (usa `node:sqlite`), pnpm 10, Rust estável (somente para o app Windows e o serviço).

```bash
pnpm install
pnpm dev:server        # API em http://localhost:7420 (dados em apps/server/.data)
pnpm dev:ui            # interface em http://localhost:5173 (proxy para a API)
pnpm dev:panel         # painel online em http://localhost:3000 (requer .env.local do Supabase)

pnpm typecheck
pnpm test              # domínio, servidor (integração), nuvem (PGlite), interface — 76 testes
pnpm test:e2e          # navegador real: operação completa + cadastro e reposição de estoque
```

Abra `http://localhost:5173` no próprio PC para o assistente de configuração inicial (por segurança, só é permitido a partir do computador local).

## Gerar o instalador do Windows

### Novidades da versão 0.1.1

- Visual Glassmorphism com cartões translúcidos, desfoque, fundos suaves e temas claro/escuro.
- Em **Estoque → Novo produto**, cadastre nome, preço e saldo inicial na mesma tela. Escolha unidades, garrafas/doses ou ingredientes; o saldo inicial gera uma entrada rastreável.
- Use **Entrada** na linha do produto para repor mercadoria com o produto e tamanho da embalagem preenchidos. O custo de compra fica separado do preço de venda.
- Busca por produto, categoria ou código e filtros por situação do estoque.

### Instalador

O GitHub Actions gera o instalador a cada push (`RupBar-instalador-windows`) e o publica em releases nas tags `v*`. Localmente, no Windows:

```powershell
pnpm install
pnpm build:installer   # interface + servidor + serviço (Rust) + Node.js oficial + Tauri/NSIS
```

Detalhes de instalação, rede, impressoras, TV, nuvem e backups em [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).

## Cobertura dos requisitos

| # | Requisito | Situação |
|---|---|---|
| 1 | App Windows + serviço local + SQLite; painel online Next.js/Supabase/Vercel | Implementado (instalador gerado na CI; ver limitações) |
| 2 | Offline-first, fila persistente, idempotência, versões, conflitos, recuperação | Implementado e testado (inclui teste de contrato PC ⇄ Postgres) |
| 3 | Assistente de primeira instalação e identidade visual | Implementado |
| 4 | Conexão por QR Code, endereço estável, descoberta e orientação | Implementado (mDNS `rupbar.local`, redescoberta na sub-rede, aviso de troca de IP) |
| 5 | Login individual, senha temporária, hash, perfis, permissões, invalidação de sessões | Implementado e testado |
| 6 | Comandas completas com controle de concorrência | Implementado e testado |
| 7 | Cadastro único de produtos e estoque rastreável | Implementado (fornecedores, entradas, inventário, lotes/validade, alertas) |
| 8 | Estoque de bebidas por mililitro, doses e garrafas abertas/fechadas | Implementado e testado |
| 9 | Fichas técnicas com baixa automática, sem duplicidade | Implementado e testado |
| 10 | Alertas de estoque e WhatsApp configurável | Implementado (Meta, Twilio, webhook) |
| 11 | Caixa, dois responsáveis, sangrias com comprovante, imutabilidade | Implementado e testado |
| 12 | Perdas locais e remotas, conflitos, relatório | Implementado e testado |
| 13 | Pedidos pelo celular sem duplicidade | Implementado e testado (E2E) |
| 14 | Painel de produção em tempo real por setor | Implementado |
| 15 | Impressoras térmicas ESC/POS com fila persistente | Implementado (rede 9100 e spooler do Windows) |
| 16 | TV de retirada, pareamento seguro, voz offline | Implementado (voz do Windows/SAPI, voz do navegador ou alerta sonoro) |
| 17 | Narguilés: aparelhos, status, locação fixa ou por período | Implementado e testado |
| 18 | Essências em gramas, mistura, carvão, indicadores | Implementado e testado |

> O texto do prompt-mestre recebido terminava na seção 18 (“Quantidade de sessões”). As seções seguintes, se existirem, não foram consideradas.

### Limitações conhecidas

- **Instalador do Windows**: gerado com sucesso na CI (runner Windows, ~25 MB com o Node.js embutido) e o supervisor do serviço foi testado (queda → reinício, parada graciosa) em Linux. A **instalação real** (serviço, firewall, WebView2) ainda precisa ser validada em um PC Windows do bar.
- **Impressão** testada com transporte simulado e geração de bytes ESC/POS; acentuação depende do modelo da impressora (CP850/CP860/sem acentos configurável).
- **HTTPS na rede local** não é usado (certificados em rede local geram alertas nos celulares). Ver [Segurança](docs/SEGURANCA-LGPD.md) para as mitigações.
- **Comprovantes (fotos/PDF)** ficam no PC; a nuvem recebe apenas a indicação de que existem.
- O esquema da nuvem está instalado no projeto Supabase compartilhado com o Barberflow (detalhes e cuidados em [IMPLANTACAO.md](docs/IMPLANTACAO.md#instalação-atual-dentro-de-um-projeto-supabase-já-existente)); falta publicar o painel na Vercel e conectar o PC do bar.
- Emissão fiscal (NFC-e/SAT) não faz parte deste escopo; o cupom de conta é marcado como “não é documento fiscal”.

---
RupBar by Ruptix
