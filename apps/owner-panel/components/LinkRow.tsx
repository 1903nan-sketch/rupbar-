'use client';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Linha de tabela que abre o detalhe ao tocar em qualquer ponto dela (no
 * celular, só o nome era clicável). O link da primeira coluna continua
 * valendo para teclado e leitores de tela.
 */
export function LinkRow({ href, selected, children }: { href: string; selected?: boolean; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      className={`clickable ${selected ? 'selected' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button, input, select, textarea, label')) return;
        router.push(href, { scroll: false });
      }}
    >
      {children}
    </tr>
  );
}
