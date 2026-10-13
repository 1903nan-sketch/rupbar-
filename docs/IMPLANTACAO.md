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
| Windows | Impressora USB instalada no Windows. Use o driver do fabricante ou “Generic / Text Only”. O RupBar envia bytes RAW pelo spooler. |
| Arquivo | Testes. |

Escolha o papel (58 mm = 32 colunas, 80 mm = 48 colunas), o setor (cozinha, bebidas) e se a impressora recebe contas/fechamento de caixa. Use **Testar**: se os acentos saírem errados, troque entre CP850, CP860 ou “sem acentos”. A fila é persistente: impressora desligada não perde cupons; eles saem quando ela voltar (até 8 tentativas, depois ficam como “Falhou” com botão “Tentar de novo”).

## 4. TV de retirada

1. No navegador da TV (ou TV box), abra `http://<IP-do-PC>:7420/tv`.
2. A TV mostra um código de 6 dígitos. No PC: Configurações → Conectar TV → digite o código.
3. Pressione OK no controle uma vez para liberar o som.

Voz: o PC sintetiza o anúncio com a voz pt-BR do Windows (offline). Se indisponível, a TV usa a voz do próprio navegador; sem voz, toca o alerta sonoro.

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

No RupBar do bar: Configurações → Sincronização → informe URL e chave pública do Supabase, e o e-mail/senha do proprietário no painel. A senha não é guardada; o PC recebe credencial própria.

## 6. WhatsApp (opcional)

Configurações → Notificações:

- **WhatsApp Cloud API (Meta)**: Phone Number ID, token e um **modelo aprovado** com um parâmetro `{{1}}` (mensagens iniciadas pela empresa exigem modelo).
- **Twilio**: Account SID, Auth Token e número remetente habilitado para WhatsApp.
- **Webhook**: qualquer provedor que aceite `POST {to, text}` (Z-API, Evolution API, n8n…).

Os avisos aguardam na fila sem internet e são enviados depois, se o produto ainda estiver abaixo do mínimo. Um aviso por produto até ele ser reposto.

## 7. Backups e recuperação

- Diário automático em `C:\ProgramData\RupBar\backups\auto-AAAA-MM-DD.db`; manual em Configurações → Backup.
- Restaurar: pare o serviço (`sc stop RupBarServer`), substitua `rupbar.db` pelo backup e apague `rupbar.db-wal`/`rupbar.db-shm`, inicie o serviço.
- Queda de energia: SQLite em WAL com `synchronous=FULL` (transações confirmadas sobrevivem); trabalhos de impressão interrompidos voltam para a fila; a outbox de sincronização é retomada.

## 8. Diagnóstico

| Sintoma | Verifique |
|---|---|
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
