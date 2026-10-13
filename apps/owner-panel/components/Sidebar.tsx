'use client';
import { ChevronsLeft, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties } from 'react';
import { BrandMark } from './BrandMark';
import { EstablishmentSwitcher, useSignOut } from './EstablishmentSwitcher';
import { isActive, NAV } from './nav';
import { ThemeToggle } from './ThemeToggle';

export interface SidebarProps {
  tradeName: string;
  initials: string;
  establishments: { id: string; trade_name: string }[];
  currentId: string | null;
}

/** Menu lateral de vidro (desktop), recolhível, com indicador que desliza até a seção ativa. */
export function Sidebar({ tradeName, initials, establishments, currentId, collapsed, onToggle }: SidebarProps & { collapsed: boolean; onToggle: () => void }) {
  const path = usePathname();
  const signOut = useSignOut();
  const idx = NAV.findIndex((n) => isActive(n.href, path));

  return (
    <aside className="sidebar" aria-label="Menu principal">
      <button
        type="button"
        className="sb-toggle"
        onClick={onToggle}
        aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expandir menu' : 'Recolher menu'}
      >
        <ChevronsLeft size={15} aria-hidden="true" />
      </button>
      <div className="sb-brand">
        <div className="avatar" aria-hidden="true">
          {initials}
        </div>
        <div className="sb-brand-text sb-label">
          <div className="sb-name">{tradeName}</div>
          <div className="sb-sub">Painel do proprietário</div>
        </div>
      </div>
      {establishments.length > 1 ? (
        <div className="sb-label sb-switch">
          <EstablishmentSwitcher establishments={establishments} currentId={currentId} id="est-desktop" />
        </div>
      ) : null}
      <nav className="sb-nav" aria-label="Seções do painel" style={{ ['--idx' as string]: Math.max(0, idx) } as CSSProperties}>
        <span className="sb-indicator" data-hidden={idx < 0 ? 'true' : undefined} aria-hidden="true" />
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(href, path);
          return (
            <Link key={href} href={href} className={`sb-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} data-tip={label}>
              <Icon size={19} strokeWidth={2} aria-hidden="true" />
              <span className="sb-label">{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sb-foot">
        <div className="sb-actions">
          <ThemeToggle />
          <button type="button" className="btn ghost sb-logout" onClick={signOut} data-tip="Sair">
            <LogOut size={17} aria-hidden="true" />
            <span className="sb-label">Sair</span>
          </button>
        </div>
        <div className="signature">
          <BrandMark size={22} id="bm-side" />
          <span className="sb-label">
            <strong>RupBar</strong> by Ruptix
          </span>
        </div>
      </div>
    </aside>
  );
}
