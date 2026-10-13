'use client';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';
import { createBrowserClient } from '@supabase/ssr';

export function supabaseBrowser() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
