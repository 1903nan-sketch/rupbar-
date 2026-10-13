'use client';
import { BarChart3, Boxes, ClipboardList, Cloud, LayoutDashboard, LogOut, PackageMinus, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

const NAV = [
  { href: '/', label: 'Visão geral', icon: LayoutDashboard },
  { href: '/vendas', label: 'Vendas', icon: BarChart3 },
  { href: '/comandas', label: 'Comandas', icon: ClipboardList },
  { href: '/estoque', label: 'Estoque', icon: Boxes },
  { href: '/perdas', label: 'Perdas', icon: PackageMinus },
  { href: '/caixas', label: 'Caixas e sangrias', icon: Wallet },
  { href: '/sincronizacao', label: 'Sincronização', icon: Cloud },
];

export function Sidebar({ tradeName, initials, establishments, currentId }: { tradeName: string; initials: string; establishments: { id: string; trade_name: string }[]; currentId: string | null }) {
  const path = usePathname();
  const router = useRouter();
  return (
    <aside className="sidebar glass">
      <div className="brand">
        <div className="logo" style={{ width: 38, height: 38, fontSize: 15 }}>{initials}</div>
        <div className="grow">
          <div className="name ellipsis">{tradeName}</div>
          <div className="tiny muted">Painel do proprietário</div>
        </div>
      </div>
      {establishments.length > 1 && (
        <select
          className="select"
          value={currentId ?? ''}
          onChange={(e) => {
            document.cookie = `rupbar_est=${e.target.value}; path=/; max-age=31536000; samesite=lax; secure`;
            router.refresh();
          }}
        >
          {establishments.map((e) => <option key={e.id} value={e.id}>{e.trade_name}</option>)}
        </select>
      )}
      <nav className="col" style={{ gap: 2, marginTop: 8 }}>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? path === '/' : path.startsWith(href);
          return (
            <Link key={href} href={href} className={`nav-link ${active ? 'active' : ''}`}>
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="footer">
        <button
          className="btn plain small"
          style={{ marginBottom: 10 }}
          onClick={async () => {
            await supabaseBrowser().auth.signOut();
            router.replace('/login');
            router.refresh();
          }}
        >
          <LogOut size={15} /> Sair
        </button>
        <div className="signature"><strong>RupBar</strong> by Ruptix</div>
      </div>
    </aside>
  );
}
