'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Confere a cada 10 s (e ao voltar para a aba) se chegou ou saiu pedido de
 * desconto; só então recarrega a página. Pedido novo vibra o celular e conta
 * no título da aba.
 */
export function DiscountWatch({ establishmentId, ids, count }: { establishmentId: string; ids: string[]; count: number }) {
  const router = useRouter();
  const known = useRef(new Set(ids));
  const key = [...ids].sort().join(',');
  useEffect(() => {
    known.current = new Set(key ? key.split(',') : []);
  }, [key]);
  // "(1) Vendas · RupBar": reaplicado quando a página troca o título.
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\) /, '');
      const want = count ? `(${count}) ${base}` : base;
      if (document.title !== want) document.title = want;
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [count]);
  useEffect(() => {
    const sb = supabaseBrowser();
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState === 'hidden') return;
      const { data, error } = await sb.from('v_discount_requests').select('id').eq('establishment_id', establishmentId).eq('status', 'pending').limit(20);
      if (stop || error || !data) return;
      const now = data.map((r) => r.id as string);
      const added = now.some((id) => !known.current.has(id));
      if (added || now.length !== known.current.size) {
        if (added) navigator.vibrate?.([180, 80, 180]);
        known.current = new Set(now);
        router.refresh();
      }
    };
    const t = window.setInterval(() => void check(), 10_000);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [establishmentId, router]);
  return null;
}
