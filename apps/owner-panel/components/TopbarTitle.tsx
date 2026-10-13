'use client';
import { ChevronRight } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { isActive, NAV } from './nav';

/** Trilha "Painel › Seção" na barra superior (desktop). */
export function TopbarTitle({ tradeName }: { tradeName: string }) {
  const path = usePathname();
  const item = NAV.find((n) => isActive(n.href, path));
  if (!item) return null;
  const Icon = item.icon;
  return (
    <nav className="topbar-title" aria-label="Você está em">
      <span className="crumb-root ellipsis">{tradeName}</span>
      <ChevronRight size={14} aria-hidden="true" className="crumb-sep" />
      <span className="crumb-current" aria-current="page">
        <Icon size={16} aria-hidden="true" />
        {item.label}
      </span>
    </nav>
  );
}
