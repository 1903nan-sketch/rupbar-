import { BellRing, ChefHat, CheckCircle2, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Logo } from '../components/brand';
import { api, ApiError } from '../lib/api';
import { applyBrandColors } from '../lib/session';

interface Board {
  branding: { tradeName: string; initials: string; primaryColor: string; secondaryColor: string; logoUrl: string | null; coverUrl: string | null };
  preparing: { number: number; name: string }[];
  ready: { number: number; name: string; readyAt: string | null; calledAt: string | null }[];
  voice: boolean;
  serverTts: boolean;
}
interface Call {
  callId: string;
  number: number;
  customerFirstName: string;
  text: string;
  voice: boolean;
}

let audioCtx: AudioContext | null = null;
/** Alerta sonoro gerado localmente (sem arquivos nem internet). */
export function chime(times = 1): void {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    void ctx.resume();
    for (let k = 0; k < times; k++) {
      [880, 1318.5].forEach((freq, i) => {
        const t = ctx.currentTime + k * 0.7 + i * 0.22;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.65);
      });
    }
  } catch {
    /* sem áudio disponível */
  }
}

function speakBrowser(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve(false);
    const voices = synth.getVoices();
    const voice = voices.find((v) => v.lang === 'pt-BR' && v.localService) ?? voices.find((v) => v.lang?.startsWith('pt'));
    if (!voice) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = 'pt-BR';
    u.rate = 0.95;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    synth.cancel();
    synth.speak(u);
    setTimeout(() => resolve(true), 12_000);
  });
}

function playUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const a = new Audio(url);
    a.onended = () => resolve(true);
    a.onerror = () => resolve(false);
    a.play().catch(() => resolve(false));
  });
}

const PAIR_KEY = 'rupbar.tv.pairing';

export function TvPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [pairing, setPairing] = useState<{ pairingId: string; code: string; secret: string; expiresAt: string } | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [soundReady, setSoundReady] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [offline, setOffline] = useState(false);
  const queue = useRef<Call[]>([]);
  const busy = useRef(false);
  const boardRef = useRef<Board | null>(null);
  boardRef.current = board;

  const load = useCallback(async () => {
    try {
      const b = await api.get<Board>('/api/tv/board');
      setBoard(b);
      setOffline(false);
      setPairing(null);
      applyBrandColors(b.branding.primaryColor, b.branding.secondaryColor);
      document.title = `${b.branding.tradeName} · Retirada`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setBoard(null);
        await startPairing();
      } else setOffline(true);
    }
  }, []);

  const startPairing = async () => {
    try {
      const saved = sessionStorage.getItem(PAIR_KEY);
      if (saved) {
        const p = JSON.parse(saved);
        if (Date.parse(p.expiresAt) > Date.now()) return setPairing(p);
      }
    } catch {
      /* ignora */
    }
    const p = await api.post<{ pairingId: string; code: string; secret: string; expiresAt: string }>('/api/tv/pair/start');
    try {
      sessionStorage.setItem(PAIR_KEY, JSON.stringify(p));
    } catch {
      /* ignora */
    }
    setPairing(p);
  };

  // Aguardando autorização do proprietário/gerente
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(async () => {
      try {
        const r = await api.post<{ status: string }>('/api/tv/pair/claim', { pairingId: pairing.pairingId, secret: pairing.secret });
        if (r.status === 'approved') {
          sessionStorage.removeItem(PAIR_KEY);
          void load();
        }
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'PAIRING_EXPIRED' || e.code === 'PAIRING_INVALID')) {
          sessionStorage.removeItem(PAIR_KEY);
          setPairing(null);
          void startPairing();
        }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [pairing, load]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    const c = setInterval(() => setClock(new Date()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [load]);

  // Mantém a tela ligada
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => void lock?.release();
  }, [board !== null]);

  const processQueue = useCallback(async () => {
    if (busy.current) return;
    const next = queue.current.shift();
    if (!next) return;
    busy.current = true;
    setCall(next);
    chime(2);
    await new Promise((r) => setTimeout(r, 1400));
    if (next.voice) {
      const b = boardRef.current;
      let ok = false;
      if (b?.serverTts) ok = await playUrl(`/api/tv/calls/${next.callId}/audio`);
      if (!ok) ok = await speakBrowser(next.text);
      if (!ok) chime(1);
    }
    await new Promise((r) => setTimeout(r, 6000));
    setCall(null);
    busy.current = false;
    void processQueue();
  }, []);

  // Tempo real (conexão própria da TV, autenticada pelo cookie do pareamento)
  useEffect(() => {
    if (!board) return;
    let ws: WebSocket | null = null;
    let stop = false;
    let attempt = 0;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        attempt = 0;
        setOffline(false);
        void load();
      };
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(String(m.data));
          if (e.type === 'pickup.call') {
            queue.current.push(e.data as Call);
            void processQueue();
            void load();
          } else if (e.type === 'board.changed' || e.type === 'branding.updated') void load();
          else if (e.type === 'device.revoked') void load();
        } catch {
          /* ignora */
        }
      };
      ws.onclose = (ev) => {
        if (stop) return;
        if (ev.code === 4401) return void load();
        setOffline(true);
        setTimeout(connect, Math.min(15_000, 1000 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      stop = true;
      ws?.close();
    };
  }, [board !== null, load, processQueue]);

  if (pairing && !board) {
    return (
      <div className="tv" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', cursor: 'default' }}>
        <div style={{ fontSize: '4vh', fontWeight: 700 }}>Conectar esta TV ao RupBar</div>
        <div className="pair-code">{pairing.code}</div>
        <div style={{ fontSize: '3vh', opacity: 0.8, maxWidth: '70vw' }}>No computador do bar, abra <strong>Configurações → Conectar TV</strong> e digite este código.</div>
        <div style={{ fontSize: '2vh', opacity: 0.5, marginTop: '4vh' }}>RupBar by Ruptix</div>
      </div>
    );
  }
  if (!board) {
    return <div className="tv" style={{ alignItems: 'center', justifyContent: 'center' }}><div style={{ fontSize: '4vh', opacity: 0.7 }}>{offline ? 'Procurando o PC do bar…' : 'Carregando…'}</div></div>;
  }

  return (
    <div className="tv" onClick={() => { if (!soundReady) { chime(1); setSoundReady(true); } }}>
      <header className="tv-head">
        <Logo branding={board.branding} size={Math.round(window.innerHeight * 0.08)} />
        <div className="name">{board.branding.tradeName}</div>
        {offline && <span style={{ fontSize: '2vh', background: 'rgba(255,159,10,.3)', padding: '.6vh 1vw', borderRadius: 999 }}>Reconectando…</span>}
        <div className="clock">{clock.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
      </header>
      <div className="tv-cols">
        <section className="tv-col">
          <h2><ChefHat size={36} /> Em preparo</h2>
          <div className="tv-list">
            {board.preparing.map((o) => (
              <div key={o.number} className="tv-order"><div className="n">{o.number}</div><div className="who">{o.name}</div></div>
            ))}
          </div>
        </section>
        <section className="tv-col ready">
          <h2><CheckCircle2 size={36} /> Prontos — retire no balcão</h2>
          <div className="tv-list">
            {board.ready.map((o) => (
              <div key={o.number} className="tv-order"><div className="n">{o.number}</div><div className="who">{o.name}</div></div>
            ))}
          </div>
        </section>
      </div>
      <footer className="tv-foot">
        <span>{!soundReady && <><Volume2 size={14} /> Pressione OK no controle para ativar o som</>}</span>
        <span>RupBar by Ruptix</span>
      </footer>
      {call && (
        <div className="tv-call">
          <div className="box">
            <div className="label"><BellRing size={40} /> Pedido pronto</div>
            <div className="big">{call.number}</div>
            {call.customerFirstName && <div className="who">{call.customerFirstName}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
