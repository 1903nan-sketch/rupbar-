import './lib/polyfills';
import { initTheme } from './lib/theme';
import { ShieldOff, WifiOff } from 'lucide-react';
import { lazy, StrictMode, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission } from '@rupbar/core';
import { Button, Card, Empty, Loading, ToastProvider } from './components/ui';
import { DesktopShell } from './layouts/DesktopShell';
import { findServer, rememberServer } from './lib/discovery';
import { SessionProvider, useSession } from './lib/session';
import { reloadForUpdate, ScreenErrorBoundary, UpdateWatcher } from './lib/update';
import { ComandaDetailPage } from './pages/ComandaDetail';
import { ComandasPage } from './pages/Comandas';
import { DashboardPage } from './pages/Dashboard';
import { KitchenPage } from './pages/Kitchen';
import { ChangePasswordPage, homeFor, LoginPage } from './pages/Login';
import { MobileComanda, MobileComandas, MobileOrders, MobileShell } from './pages/mobile/Mobile';
import { MobileQuickSale } from './pages/mobile/MobileQuickSale';
import './styles.css';
import './styles/premium.css';

// Claro, escuro ou automático: aplicado antes de desenhar a primeira tela.
initTheme();

// Páginas carregadas sob demanda: o celular do garçom baixa só o necessário.
const CashPage = lazy(() => import('./pages/Cash').then((m) => ({ default: m.CashPage })));
const HookahsPage = lazy(() => import('./pages/Hookahs').then((m) => ({ default: m.HookahsPage })));
const LossesPage = lazy(() => import('./pages/Losses').then((m) => ({ default: m.LossesPage })));
const ProductsPage = lazy(() => import('./pages/Products').then((m) => ({ default: m.ProductsPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((m) => ({ default: m.ReportsPage })));
const SetupPage = lazy(() => import('./pages/Setup').then((m) => ({ default: m.SetupPage })));
const StaffPage = lazy(() => import('./pages/Staff').then((m) => ({ default: m.StaffPage })));
const StockPage = lazy(() => import('./pages/Stock').then((m) => ({ default: m.StockPage })));
const RecipesPage = lazy(() => import('./pages/Recipes').then((m) => ({ default: m.RecipesPage })));
const TvPage = lazy(() => import('./pages/Tv').then((m) => ({ default: m.TvPage })));
const NotificationSettings = lazy(() => import('./pages/settings/Notifications').then((m) => ({ default: m.NotificationSettings })));
const SyncSettings = lazy(() => import('./pages/settings/Cloud').then((m) => ({ default: m.SyncSettings })));
const DevicesSettings = lazy(() => import('./pages/settings/Connect').then((m) => ({ default: m.DevicesSettings })));
const TvSettings = lazy(() => import('./pages/settings/Connect').then((m) => ({ default: m.TvSettings })));
const PrintersSettings = lazy(() => import('./pages/settings/Printers').then((m) => ({ default: m.PrintersSettings })));
const PixSettings = lazy(() => import('./pages/settings/Pix').then((m) => ({ default: m.PixSettings })));
const BackupSettings = lazy(() => import('./pages/settings/Settings').then((m) => ({ default: m.BackupSettings })));
const IdentitySettings = lazy(() => import('./pages/settings/Settings').then((m) => ({ default: m.IdentitySettings })));
const OperationSettings = lazy(() => import('./pages/settings/Settings').then((m) => ({ default: m.OperationSettings })));
const CorrectionsHistory = lazy(() => import('./pages/settings/Corrections').then((m) => ({ default: m.CorrectionsHistory })));
const ResetTestData = lazy(() => import('./pages/settings/ResetTestData').then((m) => ({ default: m.ResetTestData })));
const SettingsHome = lazy(() => import('./pages/settings/Settings').then((m) => ({ default: m.SettingsHome })));

/** Garante que o servidor local responde; senão tenta reencontrá-lo na rede. */
function ServerGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | 'searching' | 'lost'>('checking');
  const [msg, setMsg] = useState('');
  const check = async () => {
    try {
      const r = await fetch('/api/discovery', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      const j = (await r.json()) as { establishmentId: string | null; port: number };
      rememberServer(j.establishmentId, j.port);
      setState('ok');
    } catch {
      setState('searching');
      const found = await findServer(setMsg);
      if (found && found !== location.origin) location.href = found + location.pathname;
      else if (found) setState('ok');
      else setState('lost');
    }
  };
  useEffect(() => void check(), []);
  if (state === 'ok') return <>{children}</>;
  if (state === 'checking') return <Loading label="Conectando ao PC do bar…" />;
  return (
    <div className="center-page">
      <Card className="login-card">
        <WifiOff size={40} style={{ margin: '0 auto', color: 'var(--orange)' }} />
        <h2>{state === 'searching' ? 'Procurando o PC do bar…' : 'PC do bar não encontrado'}</h2>
        <p className="muted">{state === 'searching' ? msg : 'Verifique se o celular está no Wi-Fi do bar e se o PC está ligado. Se o problema continuar, escaneie novamente o QR Code em Configurações → Conectar dispositivo.'}</p>
        {state === 'lost' && <Button variant="primary" onClick={() => { setState('checking'); void check(); }}>Tentar novamente</Button>}
      </Card>
    </div>
  );
}

/** Aberto pelo app Android "RupBar Garçom" (o app identifica-se no user-agent). */
const IN_WAITER_APP = /RupBarGarcom\//.test(navigator.userAgent);

function RequireAuth() {
  const { user, loading, branding } = useSession();
  const loc = useLocation();
  if (loading || !branding) return <Loading />;
  if (!branding.configured) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (user.mustChangePassword && loc.pathname !== '/minha-senha') return <Navigate to="/minha-senha" replace />;
  // No app do garçom só existe a tela do celular (lançar e cobrar).
  if (IN_WAITER_APP && !loc.pathname.startsWith('/m') && loc.pathname !== '/minha-senha') return <Navigate to="/m" replace />;
  return <Outlet />;
}

function Guard({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useSession();
  if (!can(perm)) return <Card><Empty icon={<ShieldOff size={36} />} title="Sem permissão">Peça ao proprietário para liberar este acesso.</Empty></Card>;
  return <>{children}</>;
}

function LoginRoute() {
  const { user, branding, loading } = useSession();
  if (loading || !branding) return <Loading />;
  if (!branding.configured) return <Navigate to="/setup" replace />;
  // Já entrou: o celular do garçom vai para /m, o PC para o início.
  if (user && !user.mustChangePassword) return <Navigate to={homeFor(user.permissions)} replace />;
  return <LoginPage />;
}

function App() {
  return (
    <ScreenErrorBoundary>
    <UpdateWatcher />
    <Suspense fallback={<Loading />}>
    <Routes>
      <Route path="/tv" element={<TvPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireAuth />}>
        <Route path="/minha-senha" element={<ChangePasswordPage />} />
        <Route path="/m" element={<MobileShell />}>
          <Route index element={<Guard perm="comandas.view"><MobileComandas /></Guard>} />
          <Route path="comanda/:id" element={<Guard perm="comandas.view"><MobileComanda /></Guard>} />
          <Route path="pedidos" element={<Guard perm="orders.view"><MobileOrders /></Guard>} />
          <Route path="venda" element={<Guard perm="orders.create"><MobileQuickSale /></Guard>} />
        </Route>
        <Route element={<DesktopShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="comandas" element={<Guard perm="comandas.view"><ComandasPage /></Guard>} />
          <Route path="comandas/:id" element={<Guard perm="comandas.view"><ComandaDetailPage /></Guard>} />
          <Route path="producao" element={<Guard perm="kitchen.view"><KitchenPage /></Guard>} />
          <Route path="caixa" element={<Guard perm="cash.view"><CashPage /></Guard>} />
          <Route path="produtos" element={<Guard perm="products.view"><ProductsPage /></Guard>} />
          <Route path="estoque" element={<Guard perm="stock.view"><StockPage /></Guard>} />
          <Route path="fichas" element={<Guard perm="products.view"><RecipesPage /></Guard>} />
          <Route path="perdas" element={<Guard perm="losses.view"><LossesPage /></Guard>} />
          <Route path="narguiles" element={<Guard perm="hookah.view"><HookahsPage /></Guard>} />
          <Route path="relatorios" element={<Guard perm="reports.operational"><ReportsPage /></Guard>} />
          <Route path="funcionarios" element={<Guard perm="users.manage"><StaffPage /></Guard>} />
          <Route path="configuracoes" element={<SettingsHome />} />
          <Route path="configuracoes/identidade" element={<Guard perm="settings.manage"><IdentitySettings /></Guard>} />
          <Route path="configuracoes/operacao" element={<Guard perm="settings.manage"><OperationSettings /></Guard>} />
          <Route path="configuracoes/dispositivos" element={<Guard perm="devices.manage"><DevicesSettings /></Guard>} />
          <Route path="configuracoes/tv" element={<Guard perm="devices.manage"><TvSettings /></Guard>} />
          <Route path="configuracoes/impressoras" element={<Guard perm="printers.manage"><PrintersSettings /></Guard>} />
          <Route path="configuracoes/pix" element={<Guard perm="settings.manage"><PixSettings /></Guard>} />
          <Route path="configuracoes/sincronizacao" element={<Guard perm="settings.manage"><SyncSettings /></Guard>} />
          <Route path="configuracoes/notificacoes" element={<Guard perm="settings.manage"><NotificationSettings /></Guard>} />
          <Route path="configuracoes/backup" element={<Guard perm="settings.manage"><BackupSettings /></Guard>} />
          <Route path="configuracoes/correcoes" element={<Guard perm="admin.override"><CorrectionsHistory /></Guard>} />
          <Route path="configuracoes/apagar-testes" element={<Guard perm="admin.override"><ResetTestData /></Guard>} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </ScreenErrorBoundary>
  );
}

// Tela de uma versão anterior pedindo arquivo que a atualização apagou: recarrega uma vez.
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForUpdate()) e.preventDefault();
});

// Service worker: mantém a interface em cache para reabrir mesmo se o IP do PC mudar.
if ('serviceWorker' in navigator && location.pathname !== '/tv' && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}

const isTv = location.pathname.startsWith('/tv');
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        {isTv ? (
          <App />
        ) : (
          <ServerGate>
            <SessionProvider>
              <App />
            </SessionProvider>
          </ServerGate>
        )}
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
