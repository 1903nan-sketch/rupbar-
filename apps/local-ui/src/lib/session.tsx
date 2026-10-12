import type { Permission } from '@rupbar/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onAuthError } from './api';
import { contrastOn } from './format';
import { realtime, useRealtime } from './realtime';

export interface User {
  id: string;
  name: string;
  email: string;
  roleKey: string | null;
  roleName: string;
  mustChangePassword: boolean;
  permissions: string[];
}

export interface Branding {
  configured: boolean;
  establishmentId: string | null;
  tradeName: string;
  initials: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  coverUrl: string | null;
  phone: string | null;
  instagram: string | null;
}

interface SessionCtx {
  user: User | null;
  loading: boolean;
  branding: Branding | null;
  can: (p: Permission) => boolean;
  refresh: () => Promise<void>;
  refreshBranding: () => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function applyBrandColors(primary: string, secondary: string) {
  const root = document.documentElement;
  root.style.setProperty('--accent', primary);
  root.style.setProperty('--accent-contrast', contrastOn(primary));
  root.style.setProperty('--secondary', secondary);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', primary);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [branding, setBranding] = useState<Branding | null>(null);

  const refreshBranding = useCallback(async () => {
    try {
      const b = await api.get<Branding>('/api/branding');
      setBranding(b);
      applyBrandColors(b.primaryColor, b.secondaryColor);
      document.title = b.configured ? `${b.tradeName} · RupBar` : 'RupBar';
    } catch {
      /* offline: mantém a última identidade */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: User; mustChangePassword: boolean }>('/api/auth/me');
      setUser({ ...r.user, mustChangePassword: r.mustChangePassword });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshBranding();
    void refresh();
  }, [refresh, refreshBranding]);

  useEffect(() => onAuthError((e) => {
    if (e.status === 401) setUser(null);
  }), []);

  // Tempo real somente com usuário autenticado (a TV usa a própria conexão).
  useEffect(() => {
    if (user && !user.mustChangePassword) realtime.connect();
    else realtime.disconnect();
  }, [user]);

  useRealtime(['branding.updated'], () => void refreshBranding());
  useRealtime(['unauthorized', 'session.revoked'], () => void refresh());

  const value = useMemo<SessionCtx>(
    () => ({
      user,
      loading,
      branding,
      can: (p) => !!user?.permissions.includes(p),
      refresh,
      refreshBranding,
      async login(email, password) {
        const r = await api.post<{ user: User; mustChangePassword: boolean }>('/api/auth/login', {
          email, password, deviceLabel: deviceLabel(),
        });
        const u = { ...r.user, mustChangePassword: r.mustChangePassword };
        setUser(u);
        return u;
      },
      async logout() {
        await api.post('/api/auth/logout').catch(() => undefined);
        realtime.disconnect();
        setUser(null);
      },
    }),
    [user, loading, branding, refresh, refreshBranding],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua) && /RupBar|Tauri/i.test(ua)) return 'PC do bar';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Celular Android' : 'Tablet Android';
  if (/Windows/.test(ua)) return 'Computador Windows';
  return 'Navegador';
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider ausente');
  return c;
}
