'use client';
import { Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

/** Troca o estabelecimento atual (cookie lido pelo servidor). */
export function EstablishmentSwitcher({ establishments, currentId, id }: { establishments: { id: string; trade_name: string }[]; currentId: string | null; id: string }) {
  const router = useRouter();
  if (establishments.length < 2) return null;
  return (
    <div className="est-switch">
      <label htmlFor={id} className="sr-only">
        Estabelecimento
      </label>
      <Store size={15} className="est-switch-icon" aria-hidden="true" />
      <select
        id={id}
        className="select"
        value={currentId ?? ''}
        onChange={(e) => {
          document.cookie = `rupbar_est=${e.target.value}; path=/; max-age=31536000; samesite=lax; secure`;
          router.refresh();
        }}
      >
        {establishments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.trade_name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Encerra a sessão do proprietário e volta ao login. */
export function useSignOut() {
  const router = useRouter();
  return async () => {
    await supabaseBrowser().auth.signOut();
    router.replace('/login');
    router.refresh();
  };
}
