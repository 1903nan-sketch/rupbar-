import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/** Cliente Supabase no servidor, com a sessão do proprietário (RLS aplicado). */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          /* chamado de um Server Component: o middleware renova a sessão */
        }
      },
    },
  });
}
