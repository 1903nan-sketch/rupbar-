'use client';
import { LogOut, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BrandMark } from './BrandMark';
import { EstablishmentSwitcher, useSignOut } from './EstablishmentSwitcher';
import { isActive, NAV } from './nav';
import type { SidebarProps } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';

const PRIMARY = NAV.filter((n) => n.primary);

/** Celular: barra de abas inferior + menu lateral deslizante ("Mais"). */
export function MobileNav({ tradeName, initials, establishments, currentId, email }: SidebarProps & { email: string }) {
  const path = usePathname();
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const primaryIdx = PRIMARY.findIndex((n) => isActive(n.href, path));
  const idx = open || primaryIdx < 0 ? PRIMARY.length : primaryIdx;

  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      closeRef.current?.focus();
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
      window.addEventListener('keydown', onKey);
      return () => {
        document.body.style.overflow = prev;
        window.removeEventListener('keydown', onKey);
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      moreRef.current?.focus();
    }
  }, [open]);

  return (
    <>
      <nav className="tabbar" aria-label="Navegação principal" style={{ ['--idx' as string]: idx, ['--n' as string]: PRIMARY.length + 1 } as CSSProperties}>
        <span className="tabbar-indicator" aria-hidden="true" />
        {PRIMARY.map(({ href, short, label, icon: Icon }) => {
          const active = isActive(href, path);
          return (
            <Link key={href} href={href} className={`tab ${active && !open ? 'active' : ''}`} aria-current={active ? 'page' : undefined} aria-label={label}>
              <Icon size={21} strokeWidth={2} aria-hidden="true" />
              <span>{short}</span>
            </Link>
          );
        })}
        <button
          ref={moreRef}
          type="button"
          className={`tab ${open || primaryIdx < 0 ? 'active' : ''}`}
          aria-expanded={open}
          aria-controls="menu-mais"
          onClick={() => setOpen((v) => !v)}
        >
          <Menu size={21} strokeWidth={2} aria-hidden="true" />
          <span>Mais</span>
        </button>
      </nav>

      <div className="sheet-backdrop" data-open={open ? 'true' : 'false'} onClick={() => setOpen(false)} aria-hidden="true" />
      <div id="menu-mais" className="sheet" role="dialog" aria-modal="true" aria-labelledby="menu-mais-title" data-open={open ? 'true' : 'false'}>
        <div className="sheet-head">
          <div className="avatar" aria-hidden="true">
            {initials}
          </div>
          <div className="grow">
            <div className="sb-name" id="menu-mais-title">
              {tradeName}
            </div>
            <div className="sb-sub ellipsis">{email}</div>
          </div>
          <button ref={closeRef} type="button" className="btn ghost icon" onClick={() => setOpen(false)} aria-label="Fechar menu">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <EstablishmentSwitcher establishments={establishments} currentId={currentId} id="est-mobile" />
        <nav className="sheet-nav" aria-label="Todas as seções">
          {NAV.map(({ href, label, icon: Icon }, i) => {
            const active = isActive(href, path);
            return (
              <Link key={href} href={href} className={`sheet-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} style={{ ['--i' as string]: i } as CSSProperties}>
                <span className="sheet-link-icon" aria-hidden="true">
                  <Icon size={18} strokeWidth={2} />
                </span>
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="sheet-foot">
          <ThemeToggle withLabel />
          <button type="button" className="btn ghost" onClick={signOut}>
            <LogOut size={17} aria-hidden="true" /> Sair
          </button>
        </div>
        <div className="signature">
          <BrandMark size={20} id="bm-sheet" />
          <span>
            <strong>RupBar</strong> by Ruptix
          </span>
        </div>
      </div>
    </>
  );
}
