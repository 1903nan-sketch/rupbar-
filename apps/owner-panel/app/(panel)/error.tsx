'use client';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';

/** Falha ao carregar uma página do painel (ex.: sem conexão com a nuvem). */
export default function PanelError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <section className="card welcome" role="alert">
      <span className="welcome-icon danger" aria-hidden="true">
        <TriangleAlert size={28} />
      </span>
      <h1>Não foi possível carregar esta página</h1>
      <p className="muted">Verifique sua conexão com a internet e tente novamente. Os dados do bar continuam seguros no PC do estabelecimento.</p>
      <button type="button" className="btn primary" onClick={reset}>
        <RefreshCw size={16} aria-hidden="true" /> Tentar novamente
      </button>
    </section>
  );
}
