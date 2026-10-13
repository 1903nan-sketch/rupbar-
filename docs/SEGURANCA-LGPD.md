# Segurança e LGPD

## Autenticação local (PC, celulares, cozinha)

- Senhas com **scrypt** (N=2¹⁵, r=8, p=1, sal aleatório) — nunca em texto puro. Política: ≥ 8 caracteres, letras e números, sem senhas comuns nem o próprio nome/e-mail.
- Funcionários recebem **senha temporária** (gerada pelo sistema, exibida uma única vez) e são obrigados a trocá-la no primeiro acesso; até lá, todas as rotas respondem `PASSWORD_CHANGE_REQUIRED`.
- Somente o proprietário cria contas, altera permissões e redefine senhas (`users.manage`, `roles.manage` são exclusivas e não podem ser concedidas).
- **Bloqueio, troca de cargo ou de permissões invalidam imediatamente** as sessões do funcionário (`token_version`) e derrubam as conexões de tempo real.
- 5 senhas erradas → bloqueio de 5 minutos; limite de 20 tentativas de login por IP a cada 5 minutos; tempo de resposta constante para e-mail inexistente.
- Sessão em cookie `HttpOnly; SameSite=Strict`, expiração por inatividade (14 h) e absoluta (30 dias). Token guardado no banco apenas como SHA-256.
- Histórico de acessos por funcionário (entradas, falhas, saídas, trocas de senha) e encerramento remoto de sessões.

## Autorização

- Catálogo de permissões em `packages/core/src/permissions.ts`, verificado em **toda** rota do servidor (`requirePerm`).
- Perfis iniciais: Proprietário, Gerente, Caixa, Garçom, Cozinha/Balcão. Cargos personalizados e ajustes individuais (conceder/negar).
- Nenhum perfil padrão além do proprietário tem `reports.financial`. Perdas (`losses.confirm`) são exclusivas do proprietário.

## Proteções da API local

- **CSRF**: toda requisição que altera dados exige o cabeçalho `x-rupbar: 1` (navegadores não o enviam de outras origens sem CORS, que não é habilitado).
- Validação de entrada com zod em todas as rotas; SQL sempre parametrizado.
- Configuração inicial aceita apenas a partir do próprio PC (loopback).
- Cabeçalhos: CSP restritiva (somente `self`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` na API.
- Uploads: tipo detectado pelo conteúdo (JPEG/PNG/WEBP/PDF), limites de tamanho por tipo, nomes gerados pelo servidor. Logotipo/capa/fotos de produto são públicos (tela de login e TV); comprovantes exigem permissão.

## TV

- Pareamento por código de 6 dígitos exibido na TV e digitado por proprietário/gerente no PC; validade de 10 minutos. Só a TV que iniciou o pareamento (que conhece um segredo aleatório) recebe o token.
- O token da TV dá acesso **apenas** ao painel de retirada e ao áudio das chamadas. Revogável a qualquer momento.
- A TV recebe somente número do pedido e primeiro nome. Nunca CPF, telefone, valores ou forma de pagamento.

## Dados em repouso no PC

- Banco SQLite em `C:\ProgramData\RupBar`; o serviço ajusta a ACL da pasta para **SYSTEM e Administradores**.
- Segredos (credencial da nuvem, tokens do WhatsApp) cifrados com AES-256-GCM e chave mestra gerada na instalação (`master.key`, protegida pela mesma ACL).
- Backup diário automático (`backups/auto-AAAA-MM-DD.db`) e backup antes de cada atualização de esquema.

## Nuvem (Supabase)

- RLS em todas as tabelas; o proprietário só lê os dados do próprio estabelecimento. Nenhuma política de escrita: alterações apenas por funções `SECURITY DEFINER` que validam o conteúdo.
- O PC usa credencial própria de dispositivo (não a senha do proprietário). A nuvem guarda apenas o hash.
- Painel com HSTS, `X-Frame-Options`, sem indexação e sessão renovada no middleware.

## LGPD — minimização e finalidade

| Dado | Onde fica | Exibição |
|---|---|---|
| Nome do cliente | PC e nuvem | Primeiro nome em cupons de produção e TV |
| Telefone e CPF | **Somente no PC**; coleta opcional (obrigatoriedade configurável) | Mascarados (`(11) *****-4321`, `***.982.247-**`); ver completo exige permissão e é **registrado na auditoria** |
| Senhas | Hash scrypt no PC | Nunca exibidas |
| Comprovantes | Somente no PC | Usuários com permissão financeira/caixa |

- Cupons impressos não contêm CPF nem telefone.
- Eventos de tempo real não carregam dados pessoais.
- Auditoria imutável (`audit_log`) de ações sensíveis: cancelamentos, descontos, estornos, sangrias, ajustes, perdas, permissões, acessos a contato.

## Limitação conhecida: HTTP na rede local

O tráfego entre celulares e o PC usa HTTP na rede Wi-Fi do bar. HTTPS em rede local exigiria certificados autoassinados (alertas de segurança em cada celular) ou infraestrutura de DNS pública. Mitigações recomendadas:

- Rede Wi-Fi da equipe **separada** da rede de clientes, com WPA2/WPA3 e senha forte.
- Isolamento de clientes (“AP isolation”) na rede de clientes.
- Firewall do Windows libera a porta 7420 apenas em perfis **Privado/Domínio** (configurado pelo instalador).
