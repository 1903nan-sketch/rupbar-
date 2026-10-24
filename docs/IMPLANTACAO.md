# Implantação e operação

## 1. Instalar no PC do bar

1. Baixe `RupBar_x.y.z_x64-setup.exe` (artefato da CI ou release `v*`).
2. Execute como administrador. O instalador:
   - copia o aplicativo, o servidor (`server/node.exe` + `server.cjs` + interface) e o `rupbar-service.exe`;
   - instala o WebView2 se faltar;
   - registra e inicia o serviço **RupBar Server** (início automático, reinício em caso de falha);
   - cria regras de firewall (TCP 7420 e UDP 5353 em redes Privadas/Domínio);
   - protege `C:\ProgramData\RupBar` (somente SYSTEM e Administradores).
3. Abra **RupBar** pelo menu Iniciar e siga o **assistente de configuração** (estabelecimento, identidade visual, proprietário, estoque, caixa, impressora).
4. Ao final aparece o **QR Code** para conectar os celulares.

> A rede do Windows precisa estar como **Rede privada** (Configurações → Rede e Internet → propriedades da rede). Em “Rede pública” o firewall bloqueia os celulares.

### Atualizações

Instale a nova versão por cima. O instalador para o serviço, substitui os arquivos e reinicia. Na primeira execução, o servidor faz **backup automático** do banco antes de aplicar mudanças de esquema.

A versão **0.1.1** traz o novo visual Glassmorphism e o cadastro rápido de estoque. Para atualizar, use o instalador da release `v0.1.1` quando a compilação do GitHub Actions terminar. A atualização mantém o banco existente; não registre novamente o saldo inicial de produtos já cadastrados. Para repor produtos existentes, use **Estoque → Entrada**.

### Desinstalar

O desinstalador remove o serviço e as regras de firewall. **Os dados são preservados** em `C:\ProgramData\RupBar`.

## 2. Rede local

- Endereço do PC: Configurações → Conectar dispositivo (mostra IP, `rupbar.local` e o MAC).
- **Reserve o IP no roteador** (DHCP reservation / IP fixo) usando o MAC exibido. Sem a reserva, o RupBar avisa quando o IP mudar e os celulares tentam reencontrar o PC automaticamente.
- Recomendado: Wi-Fi da equipe separado do Wi-Fi de clientes.

## 3. Impressoras térmicas

Configurações → Impressoras:

| Conexão | Quando usar |
|---|---|
| Rede (porta 9100) | Impressoras Ethernet/Wi-Fi (Epson TM-T20, Elgin i9, Bematech MP-4200 TH em ESC/POS etc.). Informe o IP (veja o autoteste da impressora). |
| Windows | Impressora USB instalada no Windows. Use o driver do fabricante ou “Generic / Text Only”. O RupBar envia bytes RAW pelo spooler (drivers v4 recebem como XPS_PASS) e confere a fila do Windows: se ela estiver offline, pausada ou com cupons parados, a impressora aparece com “Atenção” em Configurações → Impressoras. |
| Arquivo | Testes. |

**Impressora USB:** ligue no PC do bar e instale o driver do fabricante (nas genéricas de 58 mm costuma ser “POS-58”). Sem driver, adicione no Windows uma impressora manual na porta **USB001** com o modelo **Generic / Text Only**. Depois, em Configurações → Impressoras → Adicionar, escolha **USB (instalada no Windows)** e selecione-a na lista (botão **Atualizar** se acabou de instalar).

**Impressora do caixa:** a primeira impressora cadastrada já vem marcada como **Impressora do caixa**. Ela imprime o **ticket de cada pedido** (venda rápida, depois do pagamento, e cada pedido das comandas) para o cliente levar ao bar e retirar, com número do pedido, nome, itens, “PAGO” (venda rápida) ou o número da comanda, e um **código de barras**. Setores sem impressora própria também saem nela. Quando colocar uma impressora na cozinha ou no bar, cadastre-a com o setor: os pedidos daquele setor passam a sair lá e o caixa continua com o ticket do cliente.

**Conferir pedido (F4):** se o cliente perder o ticket, busque pelo número do pedido, do cartão ou pelo nome, ou bipe o código de barras do ticket com o leitor. A tela mostra se está pago e se já foi entregue (“Marcar como entregue”), e imprime a 2ª via.

**Leitor de código de barras (USB):** na venda rápida e no “Lançar na comanda”, bipar o produto adiciona 1 unidade. Cadastre o código em Produtos → Código de barras (clique no campo e bipe). Bipar um ticket de pedido em qualquer tela abre a conferência.

Escolha o papel (58 mm = 32 colunas, 80 mm = 48 colunas), o setor (cozinha, bebidas) e se a impressora recebe contas/fechamento de caixa. Use **Testar**: se os acentos saírem errados, troque entre CP850, CP860 ou “sem acentos”. A fila é persistente: impressora desligada não perde cupons; eles saem quando ela voltar (até 8 tentativas, depois ficam como “Falhou” com botão “Tentar de novo”).

## 4. TV de retirada

1. No navegador da TV (ou TV box), abra `http://<IP-do-PC>:7420/tv`.
2. A TV mostra um código de 6 dígitos. No PC: Configurações → Conectar TV → digite o código.
3. Na tela "Toque para iniciar", toque na tela ou pressione OK no controle (de preferência "Iniciar em tela cheia"). Os navegadores só liberam o som depois de um toque, **a cada vez que a TV é ligada**. Sem toque, o painel abre sozinho em 30 s, mas sem som (aparece o aviso "Som bloqueado").

Chamada: um toque alto de atenção e depois a voz ("Carlos, comanda vinte e três. Seu pedido está pronto…"). A voz vem do Windows (pt-BR, offline); sem ela, a TV usa a voz do navegador. O volume, o número de toques e as repetições ficam em Configurações → Conectar TV → **Som da chamada**, que tem o botão "Testar som na TV".

Anúncios (Configurações → Conectar TV → **Anúncios na TV** e **Fotos e vídeos**):
- Envie fotos (JPG, PNG ou WEBP, até 20 MB) e vídeos (MP4 ou WEBM, até 300 MB). Arraste para ordenar e defina o tempo de cada foto.
- **Carrossel**: alterna entre os pedidos e os anúncios. **Anúncios sempre**: os pedidos só aparecem quando alguém é chamado.
- Toda chamada interrompe o anúncio na hora; depois, o vídeo continua de onde parou.
- O som dos vídeos vem desligado e pode ser ligado na mesma tela.
- Os arquivos ficam só no PC (`<dados>/tv-media`). Eles não vão para a nuvem e não entram no backup do banco: guarde uma cópia.

## 5. Nuvem e painel do proprietário

### Supabase

1. Crie um projeto em https://supabase.com (região São Paulo).
2. Aplique as migrações:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push        # aplica supabase/migrations/*.sql
   ```
3. Authentication → crie o usuário do proprietário (mesmo e-mail usado no RupBar) ou habilite o cadastro por convite.
4. Authentication → URL Configuration: adicione `https://<seu-painel>.vercel.app/auth/callback`.

#### Instalação atual: dentro de um projeto Supabase já existente

Em produção, o RupBar foi instalado no projeto Supabase já usado pelo Barberflow (`xraygbmishqxyrtiwyxy`), no esquema `public`, sem alterar nenhum objeto existente. O conteúdo de `supabase/migrations/20261012000000_rupbar_init.sql` foi aplicado em seis partes, registradas no histórico do projeto:

| Versão | Nome | Conteúdo |
|---|---|---|
| 20261013011006 | `rupbar_01_tables` | tabelas `establishments`, `devices`, `sync_records`, `remote_commands`, índices, RLS ligado |
| 20261013011840 | `rupbar_02_rls` | `rupbar_is_owner` e políticas de leitura do proprietário |
| 20261013011916 | `rupbar_03_device_rpc` | RPCs do PC (registro, envio, comandos, confirmação, sinal de vida) |
| 20261013012346 | `rupbar_04_owner_rpc` | RPCs do painel (perda remota, cancelar comando, revogar PC) |
| 20261013012520 | `rupbar_05_views_reports` | visões `v_*`, relatórios, permissões e publicação em tempo real |
| 20261013013809 | `rupbar_06_revokes` | retirada de privilégios de escrita e do papel anônimo |
| 20261013041205 | `rupbar_07_cards_quick_sale` | cartões numerados e venda rápida nas visões |
| 20261021023359 | `rupbar_08_owner_actions` | ações do painel (comanda, itens, caixa, equipe, produtos) e visão `v_presentations` |
| 20261023222958 | `rupbar_09_staff_consumption` | consumo de funcionário fora das vendas (`v_comanda_items.staff`, resumo de vendas e comparação de produtos) |
| 20261024012741 | `rupbar_10_cash_movement_status` | caixa aberto no painel: `v_cash_movements.status` (sangria/suprimento anulado fica fora do dinheiro esperado) |
| 20261024015652 | `rupbar_11_comanda_discount` | descontos no painel: `v_comandas.discount_reason` e `closed_by` |

Consequências de compartilhar o projeto:

- **Login compartilhado**: o painel usa o mesmo Supabase Auth do Barberflow. Qualquer conta do Barberflow consegue entrar no painel do RupBar, mas não vê nada (o RLS só mostra estabelecimentos dos quais a conta é proprietária).
- **Site URL**: não altere a Site URL do projeto (ela é do Barberflow). Apenas **adicione** `https://<seu-painel>.vercel.app/auth/callback` em *Redirect URLs*.
- **`supabase db push`** não deve ser usado contra esse projeto a partir deste repositório: o histórico remoto contém as migrações do Barberflow, que não estão aqui. Mudanças futuras no esquema do RupBar devem ser aplicadas como novas migrações nomeadas `rupbar_*` (pelo SQL Editor ou pela CLI do repositório do Barberflow).
- Os objetos do RupBar são identificados pelos nomes acima (`rupbar_*`, `v_*` do RupBar e as quatro tabelas); para mover o RupBar para um projeto próprio no futuro, basta aplicar `20261012000000_rupbar_init.sql` no projeto novo e reconectar o PC.

### Vercel

1. Importe o repositório; **Root Directory** = `apps/owner-panel` (a Vercel detecta pnpm/monorepo).
2. Variáveis: `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Deploy.

### Conectar o PC

No RupBar do bar: Configurações → Sincronização → informe o **e-mail e a senha do painel online** (o mesmo login do painel). A nuvem do RupBar já vem configurada; URL e chave só são necessárias em "Avançado", para usar outro projeto Supabase. A senha não é guardada; o PC recebe credencial própria.

Se der erro, a mensagem diz a causa (senha errada, sem internet, certificado bloqueado por antivírus, firewall). O serviço usa os certificados do Windows, então antivírus que inspecionam HTTPS não impedem mais a conexão.

## 5.1 Operação do dia a dia (0.2)

- **Cartões numerados**: imprima cartões com números (1, 2, 3…). Para abrir uma comanda, digite o número do cartão. O número só pode estar em uma comanda aberta por vez e fica livre quando ela é encerrada.
- **Venda rápida (F2)**: para quem pede no balcão e paga na hora. Informe o nome para a TV chamar. O pedido vai para a produção e o pagamento entra no caixa.
- **Lançar na comanda (F3)**: digite o número do cartão e escolha os itens. Se o cartão estiver livre, a comanda é aberta na hora.
- **Narguilé**: em Narguilés → "Alterar valores" ficam o aluguel (essência e carvão inclusos), a troca de rosh e o rosh do narguilé próprio. Tudo é lançado na comanda no momento e **não há devolução**: as locações terminam sozinhas quando a comanda é encerrada (o aparelho da lista vai para limpeza). No celular, a comanda tem a aba **Narguilé**: "Alugar narguilé" (escolha o sabor; o aparelho é opcional), "Trocar rosh", "Narguilé do cliente" e "Pacote de essência fechado".
- **Doses com escolhas (energético, gelo, sabor)**: no cadastro do produto (Novo produto → passo 5, ou Produtos → abrir → "Escolhas no pedido"), crie escolhas como **Energético** (Red Bull +R$ 8, Monster +R$ 5, Sem energético) e **Gelo** (coco +R$ 2, comum). Cada opção tem o seu preço a mais e pode baixar um produto do estoque (1 lata de Red Bull, 1 gelo de coco). No pedido, ao tocar na dose, o garçom escolhe o energético e o gelo; o preço soma e o estoque baixa o que foi escolhido. A mesma escolha pode ser usada em várias doses. Opção sem saldo aparece como esgotada.
- **Dose e garrafa fechada**: no Novo produto (garrafa de X ml → "Por dose"), preencha também "Também vende a garrafa fechada?". A dose baixa os ml; a garrafa fechada baixa a garrafa inteira.
- **Combos** (Produtos → **Novo combo**): preço do combo, o que vai sempre (ex.: 1 garrafa de gin, inteira) e o que o cliente escolhe com quantidade (ex.: Sabor do gelo × 5, Energético × 4). Ao vender, baixa a garrafa e os 5 gelos e 4 latas do que foi escolhido; opção com preço a mais (Red Bull) soma 4 vezes.
- **Tela de produção**: pedido pronto sai sozinho depois de 10 minutos (Configurações → Operação → "Pedido pronto sai da tela de produção depois de").
- **Garçom que também é caixa**: Funcionários → editar → **"Também trabalha no caixa"**. Ele abre e fecha o caixa, recebe pagamentos e encerra comandas, inclusive pelo celular (se o caixa estiver fechado, a aba Cobrar oferece "Abrir caixa").
- **Essência**: cadastre em Estoque → Novo produto → "Pacote de X g", categoria Essências. Em "Como você vende?", escolha **"Pacote fechado + narguilé"** para vender o pacote fechado no cardápio; o narguilé continua usando a mesma essência por grama, sem cobrar. "Só no narguilé ou em receitas" não aparece no cardápio. Sabor ou carvão sem saldo não travam o aluguel no celular: só não dão baixa.
- **Pix**: em Configurações → Pix, informe a chave, o nome e a cidade. É um Pix estático: confira o crédito no app do banco antes de confirmar o pagamento.
- **Conta mestre**: só o proprietário vê os botões de editar e excluir em comandas, pagamentos, caixa, estoque, perdas e narguilés. Cada correção pede um motivo e aparece em Configurações → Histórico de correções.

## 6. WhatsApp (opcional)

Configurações → Notificações (assistente em 4 passos):

- **Evolution API (recomendado)**: endereço do servidor (pode colar o link do painel `/manager`), chave da API (`AUTHENTICATION_API_KEY`, guardada cifrada) e nome da instância. “Testar conexão” mostra o estado (Conectado / Aguardando QR / Desconectado); se a instância não existir, “Criar instância”. Depois é só ler o QR Code no WhatsApp do celular (Aparelhos conectados → Conectar um aparelho). Compatível com Evolution v2 e v1.
- **WhatsApp Cloud API (Meta)**: Phone Number ID, token e um **modelo aprovado** com um parâmetro `{{1}}` (mensagens iniciadas pela empresa exigem modelo).
- **Twilio**: Account SID, Auth Token e número remetente habilitado para WhatsApp.
- **Webhook**: qualquer provedor que aceite `POST {to, text}` (Z-API, n8n…).

Avisos disponíveis: estoque baixo (padrão) e resumo do fechamento de caixa. Os avisos aguardam na fila sem internet e são enviados depois, se ainda forem pertinentes (estoque ainda abaixo do mínimo). Um aviso por produto até ele ser reposto.

## 7. Backups e recuperação

- Diário automático em `C:\ProgramData\RupBar\backups\auto-AAAA-MM-DD.db`; manual em Configurações → Backup.
- Restaurar: pare o serviço (`sc stop RupBarServer`), substitua `rupbar.db` pelo backup e apague `rupbar.db-wal`/`rupbar.db-shm`, inicie o serviço.
- Queda de energia: SQLite em WAL com `synchronous=FULL` (transações confirmadas sobrevivem); trabalhos de impressão interrompidos voltam para a fila; a outbox de sincronização é retomada.

## 8. Diagnóstico

| Sintoma | Verifique |
|---|---|
| Erro “VCRUNTIME140.dll não foi encontrado” (rupbar-service.exe) | Versões até a 0.2.0 dependiam do Visual C++ Redistributable. Instale a versão nova por cima (o serviço já leva a biblioteca embutida) ou instale o “Microsoft Visual C++ Redistributable x64” do site da Microsoft e reinstale o RupBar. |
| Janela fica em “Iniciando o servidor local…” | `services.msc` → RupBar Server; logs em `C:\ProgramData\RupBar\logs\service.log` e `rupbar-server.log` |
| Celular não abre o endereço | Mesmo Wi-Fi? Rede do Windows como Privada? IP mudou (veja Conectar dispositivo)? |
| Impressora não imprime | Configurações → Impressoras → histórico; teste de impressão; IP/porta 9100 |
| Painel “desatualizado” | Internet do bar, Configurações → Sincronização (estado e último erro) |

Comandos úteis (PowerShell como administrador):

```powershell
sc query RupBarServer
sc stop RupBarServer
sc start RupBarServer
"C:\Program Files\RupBar\rupbar-service.exe" install     # reinstala serviço e firewall
```
