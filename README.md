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
| `apps/android` | App Android “RupBar Garçom” (Kotlin, sem bibliotecas): encontra o PC na rede Wi-Fi e abre `/m` em tela cheia. APK gerado na CI (`gradle assembleRelease`), incluído no instalador do Windows e servido pelo PC em `/download/rupbar-garcom.apk`. |
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
pnpm test              # domínio, servidor (integração), nuvem (PGlite), interface
pnpm test:e2e          # navegador real: operação completa + cadastro, reposição e importação de estoque
```

Abra `http://localhost:5173` no próprio PC para o assistente de configuração inicial (por segurança, só é permitido a partir do computador local).

## Gerar o instalador do Windows

### Ajustes após a 0.2.0

- **Narguilé sem devolução**: aluguel e trocas entram na comanda na hora e a locação termina sozinha quando a comanda é encerrada. O aluguel pode ser feito sem escolher aparelho.
- **Aba Narguilé no celular do garçom**: alugar (sabor em um toque), trocar rosh, narguilé do cliente e pacote de essência fechado.
- **Essência em pacote fechado**: o mesmo produto é vendido fechado no cardápio e usado por grama no narguilé, sem cobrar a essência do aluguel.
- **Pix**: já vem ligado ao cadastrar a chave, e o caixa liga o Pix na própria tela de pagamento.
- **Impressora USB do caixa**: imprime o ticket de cada pedido (venda rápida e comandas) para o cliente retirar no bar, com código de barras. Com uma impressora só, tudo sai nela; impressoras de setor podem ser adicionadas depois.
- **Conferir pedido (F4)**: cliente perdeu o ticket? Bipe ou busque pelo número/nome e veja se pagou e se já retirou; 2ª via e “Marcar como entregue”.
- **Doses com escolhas**: a dose tem o preço dela e, no pedido, o garçom escolhe o energético (Red Bull, Monster…) e o gelo, cada um com preço à parte; o estoque baixa a lata e o gelo escolhidos. Configurado no próprio cadastro do produto.
- **Combos e garrafa fechada**: dose baixa ml, garrafa fechada baixa a garrafa, combo baixa a garrafa e os adicionais escolhidos (5 gelos, 4 energéticos).
- **Produção sem acumular**: pronto sai sozinho da tela depois de alguns minutos.
- **Garçom que também é caixa**: um botão no cadastro do funcionário.
- **Leitor de código de barras**: bipar o produto na venda rápida ou no “Lançar na comanda” adiciona ao pedido.
- **Dose pura, dose com energético e garrafa da mesma garrafa**: escolhas (energético, gelo) podem valer só para uma apresentação; todas baixam do mesmo produto.
- **Meio a meio na hora do pedido**: na venda rápida, no lançar na comanda ou no celular, toque em “Meio a meio” e escolha duas porções (ex.: meia batata grande + meia polenta). Cobra a mais cara e baixa metade de cada, sem cadastrar nada.
- **Venda rápida no celular do garçom** e opção “Cobra no celular” em Funcionários: recebe, encerra a comanda e faz venda rápida sem abrir nem fechar o caixa.
- **Narguilé só com essências**: os sabores do rosh vêm da categoria Essências (comida em gramas não aparece); o mesmo produto vende o pacote fechado no cardápio.
- **Apagar dados de teste** (conta mestre, em Configurações): zera vendas, caixas, relatórios, estoque e, se quiser, os produtos, para começar a operação do zero. Pede a senha do proprietário, faz uma cópia de segurança antes e apaga também do painel online.
- **Importar planilha do estoque**: em Estoque → Importar planilha, baixe o modelo, preencha a contagem no Excel (fechados + soltos, custo, preço, dose) e salve como CSV. O sistema mostra linha a linha o que vai acontecer; produtos novos entram com saldo, custo e preço, e os já cadastrados recebem a contagem como inventário.

### Novidades da versão 0.2.0

- **Visual novo** em vidro fosco com fundo animado, no PC, no celular do garçom, na produção, na TV e no painel online.
- **Tela inicial com atalhos**: Venda rápida (F2), Lançar na comanda (F3) e Tela cheia (F11).
- **Venda rápida (balcão)**: o cliente paga na hora (troco, Pix com QR, divisão) e é chamado pelo nome na TV.
- **Cartões numerados**: abra a comanda pelo número do cartão. O número aparece na produção, na TV, nos cupons e no painel online.
- **Narguilé**: tabela única com aluguel (essência e carvão inclusos), troca de rosh e narguilé próprio do cliente (essência e carvão lançados na comanda). Troca cortesia e "Alterar valores" em um clique.
- **Pix copia e cola**: configure a chave, o nome e a cidade. O QR aparece no pagamento, na venda rápida e na conta impressa.
- **Produção**: nome do cliente em destaque, número da comanda, cronômetro de atraso e alerta sonoro forte.
- **TV**: nome grande, toque alto antes da voz e anúncios (fotos e vídeos) em carrossel ou contínuos. Os anúncios são interrompidos quando há chamada e o som dos vídeos pode ser ligado ou desligado.
- **App do garçom**: teclado numérico para abrir a comanda pelo cartão e cardápio em blocos.
- **Estoque autoexplicativo**: "como você compra / como você vende", fardo × lata com conta pronta, aviso de engano e código automático de produto.
- **WhatsApp pela Evolution API**: assistente passo a passo com QR Code.
- **Conta mestre**: o proprietário edita e exclui pagamentos, itens, comandas encerradas, sangrias, caixa, entradas de estoque, perdas e locações. Toda correção pede motivo e fica no Histórico de correções.
- **Nuvem**: o PC conecta só com o e-mail e a senha do painel.

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
| 10 | Alertas de estoque e WhatsApp configurável | Implementado (Evolution API com assistente e QR Code, Meta, Twilio, webhook) |
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
- **App Android do garçom**: compilado na CI; ainda precisa ser testado em aparelhos reais (descoberta na rede, Wi-Fi sem internet com dados móveis ligados, instalação fora da Play Store). Para que atualizações instalem por cima, configure os segredos `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` e `ANDROID_KEY_PASSWORD` (sem eles o APK sai com uma chave de depuração temporária).
- **HTTPS na rede local** não é usado (certificados em rede local geram alertas nos celulares). Ver [Segurança](docs/SEGURANCA-LGPD.md) para as mitigações.
- **Comprovantes (fotos/PDF)** ficam no PC; a nuvem recebe apenas a indicação de que existem.
- O esquema da nuvem está instalado no projeto Supabase compartilhado com o Barberflow (detalhes e cuidados em [IMPLANTACAO.md](docs/IMPLANTACAO.md#instalação-atual-dentro-de-um-projeto-supabase-já-existente)); falta publicar o painel na Vercel e conectar o PC do bar.
- Emissão fiscal (NFC-e/SAT) não faz parte deste escopo; o cupom de conta é marcado como “não é documento fiscal”.

---
RupBar by Ruptix
