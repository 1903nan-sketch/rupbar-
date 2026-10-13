import type { ReactNode } from 'react';

/** Remontado a cada navegação: dá a transição suave entre páginas. */
export default function PanelTemplate({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
