/**
 * Nuvem padrão do RupBar (Ruptix). A chave é a pública (anon): só permite o
 * que o RLS e as funções RPC liberam, por isso pode ir no aplicativo.
 * O proprietário só informa o e-mail e a senha do painel online.
 */
export const RUPBAR_CLOUD = {
  url: 'https://xraygbmishqxyrtiwyxy.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyYXlnYm1pc2hxeHlydGl3eXh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MjU0NTUsImV4cCI6MjEwNTUwMTQ1NX0.MSznUZ4w8ZW8y4PTjbQmQiT8BEDhnA3enDs6quIk6OI',
} as const;
