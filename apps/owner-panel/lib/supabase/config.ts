import { RUPBAR_CLOUD } from '@rupbar/core';

/**
 * URL e chave pública do Supabase. Valores colados na Vercel às vezes trazem
 * espaços, quebras de linha ou caracteres invisíveis, que quebram os
 * cabeçalhos HTTP ("non ISO-8859-1 code point"): URL e JWT são ASCII puro,
 * então removemos o resto. Sem variáveis, usa a nuvem padrão do RupBar.
 */
const ascii = (v: string | undefined) => (v ?? '').replace(/[^\x21-\x7E]/g, '').replace(/^["']|["']$/g, '');

const looksLikeKey = (k: string) => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(k) || /^sb_publishable_[\w-]+$/.test(k);

const envUrl = ascii(process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, '');
export const SUPABASE_URL = /^https:\/\/[\w.-]+(:\d+)?$/.test(envUrl) ? envUrl : RUPBAR_CLOUD.url;
const envKey = ascii(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
/** Chave colada pela metade (ex.: com "…") no projeto padrão: usa a chave conhecida. */
export const SUPABASE_ANON_KEY = looksLikeKey(envKey) || (envKey && SUPABASE_URL !== RUPBAR_CLOUD.url) ? envKey : RUPBAR_CLOUD.anonKey;
