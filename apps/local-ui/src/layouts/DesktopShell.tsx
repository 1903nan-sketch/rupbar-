import { parsePickupCode, type Permission } from '@rupbar/core';
import {
  BarChart3, Boxes, ChefHat, ClipboardList, ClipboardPlus, Cog, KeyRound, LayoutDashboard, LogOut, Maximize2, Menu, Minimize2, PackageMinus,
  ScanBarcode, Smartphone, Tv, UserRound, Users, Wallet, Wind, Wine, Zap,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { ConnectionBanner, Logo, RupbarSignature, SyncIndicator } from '../components/brand';
import { DiscountNotices } from '../components/DiscountRequest';
import { Button, Loading } from '../components/ui';
import { api } from '../lib/api';
import { useFullscreen } from '../lib/fullscreen';
import { useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useBarcodeScanner } from '../lib/scanner';
import { useSession } from '../lib/session';
import { ScreenErrorBoundary } from '../lib/update';

const QuickSale = lazy(() => import('../components/QuickSale').then((m) => ({ default: m.QuickSale })));
const LaunchComanda = lazy(() => import('../components/LaunchComanda').then((m) => ({ default: m.LaunchComanda })));
const OrderLookup = lazy(() => import('../components/OrderLookup').then((m) => ({ default: m.OrderLookup })));

/** Atalhos disponíveis em qualquer tela do PC (tela inicial, comandas…). */
export interface ShellActions {
  openQuickSale: () => void;
  openLaunch: (number?: number) => void;
  openLookup: () => void;
  fullscreen: boolean;
  toggleFullscreen: () => void;
}
export const useShellActions = () => useOutletContext<ShellActions>();

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perm?: Permission;
  count?: number;
}

export function DesktopShell() {
  const { branding, user, can, logout } = useSession();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { data: dash, reload } = useLoad(() => api.get('/api/dashboard'), []);
  useRealtime(['stock', 'kitchen', 'comandas'], () => void reload());
  const [quick, setQuick] = useState(false);
  const [launch, setLaunch] = useState<{ number?: number } | null>(null);
  const [lookup, setLookup] = useState<{ q: string } | null>(null);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const canQuick = can('orders.create') && can('cash.payment');
  const canLaunch = can('orders.create');
  const canLookup = can('orders.view');
  const actions: ShellActions = {
    openQuickSale: () => canQuick && setQuick(true),
    openLaunch: (number) => canLaunch && setLaunch({ number }),
    openLookup: () => canLookup && setLookup({ q: '' }),
    fullscreen,
    toggleFullscreen,
  };

  // Bipar o ticket do pedido em qualquer tela abre a conferência (pago? já entregue?).
  useBarcodeScanner((code) => {
    if (!parsePickupCode(code)) return false;
    setLookup({ q: code });
    return true;
  }, canLookup);

  // F2 venda rápida · F3 lançar na comanda · F4 conferir pedido · F11 tela cheia
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2' && canQuick) {
        e.preventDefault();
        setQuick(true);
      } else if (e.key === 'F3' && canLaunch) {
        e.preventDefault();
        setLaunch({});
      } else if (e.key === 'F4' && canLookup) {
        e.preventDefault();
        setLookup({ q: '' });
      } else if (e.key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canQuick, canLaunch, canLookup, toggleFullscreen]);

  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: 'Operação',
      items: [
        { to: '/', label: 'Início', icon: <LayoutDashboard size={18} /> },
        { to: '/comandas', label: 'Comandas', icon: <ClipboardList size={18} />, perm: 'comandas.view', count: undefined },
        { to: '/producao', label: 'Cozinha e balcão', icon: <ChefHat size={18} />, perm: 'kitchen.view', count: dash?.inProduction || undefined },
        { to: '/caixa', label: 'Caixa', icon: <Wallet size={18} />, perm: 'cash.view' },
        { to: '/narguiles', label: 'Narguilés', icon: <Wind size={18} />, perm: 'hookah.view' },
      ],
    },
    {
      label: 'Estoque',
      items: [
        { to: '/produtos', label: 'Produtos', icon: <Wine size={18} />, perm: 'products.view' },
        { to: '/estoque', label: 'Estoque', icon: <Boxes size={18} />, perm: 'stock.view', count: dash?.stockAlerts || undefined },
        { to: '/perdas', label: 'Perdas', icon: <PackageMinus size={18} />, perm: 'losses.view', count: dash?.lossConflicts || undefined },
      ],
    },
    {
      label: 'Gestão',
      items: [
        { to: '/relatorios', label: 'Relatórios', icon: <BarChart3 size={18} />, perm: 'reports.operational' },
        { to: '/funcionarios', label: 'Funcionários', icon: <Users size={18} />, perm: 'users.manage' },
        { to: '/configuracoes', label: 'Configurações', icon: <Cog size={18} />, perm: 'settings.manage' },
        { to: '/configuracoes/dispositivos', label: 'Conectar dispositivo', icon: <Smartphone size={18} />, perm: 'devices.manage' },
        { to: '/configuracoes/tv', label: 'Conectar TV', icon: <Tv size={18} />, perm: 'devices.manage' },
      ],
    },
  ];

  return (
    <div className="shell">
      {open && <div className="overlay" style={{ zIndex: 55, background: 'rgba(0,0,0,.2)' }} onClick={() => setOpen(false)} />}
      <aside className={`sidebar glass ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="brand">
          <Logo branding={branding} size={38} />
          <div className="grow">
            <div className="name ellipsis">{branding?.tradeName ?? 'RupBar'}</div>
            <div className="tiny muted">RupBar</div>
          </div>
        </div>
        {groups.map((g) => {
          const items = g.items.filter((i) => !i.perm || can(i.perm));
          if (!items.length) return null;
          return (
            <nav key={g.label} className="col" style={{ gap: 2 }}>
              <div className="nav-group">{g.label}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/' || i.to === '/configuracoes'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                  {i.icon}
                  <span>{i.label}</span>
                  {i.count ? <span className="count">{i.count}</span> : null}
                </NavLink>
              ))}
            </nav>
          );
        })}
        <div className="footer">
          <RupbarSignature />
        </div>
      </aside>
      <div className="main">
        <ConnectionBanner />
        <DiscountNotices />
        <header className="topbar glass">
          <Button variant="plain" className="show-mobile" icon={<Menu size={20} />} aria-label="Menu" onClick={() => setOpen(true)} />
          <div className="grow small muted ellipsis">{titleFor(loc.pathname)}</div>
          {canQuick && <Button size="small" variant="primary" className="topbar-action" icon={<Zap size={15} />} title="Venda rápida (F2)" onClick={() => setQuick(true)}>Venda rápida</Button>}
          {canLaunch && <Button size="small" className="topbar-action" icon={<ClipboardPlus size={15} />} title="Lançar na comanda (F3)" onClick={() => setLaunch({})}>Lançar na comanda</Button>}
          {canLookup && <Button size="small" className="topbar-action secondary" icon={<ScanBarcode size={15} />} title="Conferir pedido: bipe o ticket ou busque pelo número (F4)" onClick={() => setLookup({ q: '' })}>Conferir pedido</Button>}
          <Button size="small" variant="plain" icon={fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />} title={fullscreen ? 'Sair da tela cheia (F11)' : 'Tela cheia (F11)'} aria-label="Tela cheia" onClick={toggleFullscreen} />
          <SyncIndicator />
          <div className="row" style={{ gap: 4 }}>
            <UserRound size={16} className="muted" />
            <span className="small strong ellipsis" style={{ maxWidth: 160 }}>{user?.name}</span>
            <span className="badge">{user?.roleName}</span>
          </div>
          <NavLink to="/minha-senha" className="btn plain small icon" title="Alterar minha senha"><KeyRound size={16} /></NavLink>
          <Button variant="plain" size="small" icon={<LogOut size={16} />} title="Sair" onClick={() => void logout()} />
        </header>
        <main className="content">
          {/* A tela carrega aqui dentro (o menu fica); arquivo de versão antiga recarrega sozinho. */}
          <ScreenErrorBoundary key={loc.pathname}>
            <Suspense fallback={<Loading />}>
              <Outlet context={actions} />
            </Suspense>
          </ScreenErrorBoundary>
        </main>
      </div>
      <Suspense fallback={null}>
        {quick && <QuickSale onClose={() => setQuick(false)} />}
        {launch && <LaunchComanda initialNumber={launch.number} onClose={() => setLaunch(null)} />}
        {lookup && <OrderLookup key={lookup.q} initial={lookup.q} onClose={() => setLookup(null)} />}
      </Suspense>
    </div>
  );
}

function titleFor(path: string): string {
  if (path.startsWith('/comandas')) return 'Comandas';
  if (path.startsWith('/producao')) return 'Cozinha e balcão';
  if (path.startsWith('/caixa')) return 'Caixa';
  if (path.startsWith('/produtos')) return 'Produtos';
  if (path.startsWith('/estoque')) return 'Estoque';
  if (path.startsWith('/perdas')) return 'Perdas';
  if (path.startsWith('/narguiles')) return 'Narguilés';
  if (path.startsWith('/relatorios')) return 'Relatórios';
  if (path.startsWith('/funcionarios')) return 'Funcionários';
  if (path.startsWith('/configuracoes')) return 'Configurações';
  return new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
}

