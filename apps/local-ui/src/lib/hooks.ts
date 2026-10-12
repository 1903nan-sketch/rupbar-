import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/** Carrega dados com estado de carregamento/erro e função de recarga. */
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(loader);
  ref.current = loader;
  const ctrl = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    try {
      const d = await ref.current(c.signal);
      if (!c.signal.aborted) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (!c.signal.aborted) setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    return () => ctrl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Relógio que atualiza a cada `ms` (tempo de espera, cronômetros). */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

/** Ação assíncrona com estado "ocupado" — evita cliques duplos. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      setBusy(true);
      try {
        return await fn(...args);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fn],
  );
  return [run, busy] as const;
}
