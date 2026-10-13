'use client';
import { useState, type ReactNode } from 'react';
import { MobileNav } from './MobileNav';
import { Sidebar, type SidebarProps } from './Sidebar';

/** Estrutura do painel: menu lateral (desktop), barra superior, conteúdo e abas (celular). */
export function Shell({ initialCollapsed, email, topbar, children, ...nav }: SidebarProps & { initialCollapsed: boolean; email: string; topbar: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    const secure = location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `rupbar_sidebar=${next ? 'collapsed' : 'open'}; path=/; max-age=31536000; samesite=lax${secure}`;
  };
  return (
    <div className="shell" data-collapsed={collapsed ? 'true' : 'false'}>
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>
      <Sidebar {...nav} collapsed={collapsed} onToggle={toggle} />
      <div className="main">
        {topbar}
        <main id="conteudo" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <MobileNav {...nav} email={email} />
    </div>
  );
}
