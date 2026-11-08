import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Configuração padrão: sem cache incremental (as páginas do painel são dinâmicas).
export default defineCloudflareConfig();
