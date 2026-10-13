'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Recarrega os dados do servidor periodicamente enquanto a aba está visível
 * (e ao voltar para a aba, se a última atualização já tiver ficado para trás).
 */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      router.refresh();
    };
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(), seconds * 1000);
    const onVisible = () => document.visibilityState === 'visible' && Date.now() - last > (seconds * 1000) / 2 && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, seconds]);
  return null;
}
