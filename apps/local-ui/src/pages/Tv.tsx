import { BellRing, ChefHat, CircleCheck, Maximize, Minimize, Play, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Logo } from '../components/brand';
import { api, ApiError } from '../lib/api';
import { applyBrandColors } from '../lib/session';
import '../styles/tv.css';
import { AdsLayer } from './tv/AdsLayer';
import { attentionChime, audioUnlocked, onAudioStateChange, playVoiceUrl, speakBrowser, unlockAudio } from './tv/audio';
import { useFullscreen, type Fullscreen } from './tv/fullscreen';
import { DEFAULT_DISPLAY, type TvBoard, type TvCall, type TvEntry, type TvReadyEntry } from './tv/types';

// Compatibilidade: o painel da cozinha usa o alerta curto.
export { chime } from './tv/audio';

const PAIR_KEY = 'rupbar.tv.pairing';
/** Sem toque na tela inicial, o painel abre sozinho (sem som) após este tempo. */
const GATE_SECONDS = 30;
/** Tempo mínimo de destaque de cada chamada. */
const CALL_MIN_MS = 8000;
/** Pedido pronto/chamado há menos que isto ganha brilho no painel. */
const FRESH_MS = 90_000;
/** Barra de botões some após este tempo sem interação. */
const TOOLS_HIDE_MS = 4000;

type Pairing = { pairingId: string; code: string; secret: string; expiresAt: string };
type Scene = 'board' | 'ads';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Toque de atenção + voz, repetidos conforme a configuração da TV. */
async function announce(call: TvCall, board: TvBoard | null): Promise<void> {
  const d = board?.display ?? DEFAULT_DISPLAY;
  const vol = d.volume / 100;
  for (let i = 0; i < d.callRepeat; i++) {
    if (i > 0) await sleep(700);
    await attentionChime(d.chimeRepeat, vol);
    if (!call.voice || vol <= 0) continue;
    let ok = false;
    if (board?.serverTts) ok = await playVoiceUrl(`/api/tv/calls/${encodeURIComponent(call.callId)}/audio`, vol);
    if (!ok) ok = await speakBrowser(call.text, vol);
    if (!ok) await attentionChime(1, vol); // sem voz disponível: toque extra
  }
}

export function TvPage() {
  const [board, setBoard] = useState<TvBoard | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [offline, setOffline] = useState(false);
  const [started, setStarted] = useState(false);
  const [audioOk, setAudioOk] = useState(audioUnlocked);
  const [call, setCall] = useState<TvCall | null>(null);
  const [queued, setQueued] = useState(0);
  const [scene, setScene] = useState<Scene>('board');
  const [hold, setHold] = useState<{ seconds: number; at: number } | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [toolsShown, setToolsShown] = useState(false);
  const [idle, setIdle] = useState(true);
  const [tick, setTick] = useState(() => Date.now());
  const fs = useFullscreen();

  const queue = useRef<TvCall[]>([]);
  const busy = useRef(false);
  const boardRef = useRef<TvBoard | null>(null);
  boardRef.current = board;
  /** Diferença entre o relógio do PC e o da TV (TV box costuma estar com hora errada). */
  const offset = useRef(0);
  const phaseStart = useRef(Date.now());
  const toolsRef = useRef<HTMLDivElement>(null);

  const startPairing = useCallback(async () => {
    try {
      const saved = sessionStorage.getItem(PAIR_KEY);
      if (saved) {
        const p = JSON.parse(saved) as Pairing;
        if (Date.parse(p.expiresAt) > Date.now()) return setPairing(p);
      }
    } catch {
      /* ignora */
    }
    const p = await api.post<Pairing>('/api/tv/pair/start');
    try {
      sessionStorage.setItem(PAIR_KEY, JSON.stringify(p));
    } catch {
      /* ignora */
    }
    setPairing(p);
  }, []);

  const load = useCallback(async () => {
    try {
      const b = await api.get<TvBoard>('/api/tv/board');
      if (b.serverTime) offset.current = Date.parse(b.serverTime) - Date.now();
      setBoard(b);
      setOffline(false);
      setPairing(null);
      applyBrandColors(b.branding.primaryColor, b.branding.secondaryColor);
      document.title = `${b.branding.tradeName} · Retirada`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setBoard(null);
        await startPairing().catch(() => setOffline(true));
      } else setOffline(true);
    }
  }, [startPairing]);

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
  }, [pairing, load, startPairing]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    // Relógio lento para o brilho de "pronto agora" (o relógio da tela tem o seu).
    const c = setInterval(() => setTick(Date.now()), 10_000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [load]);

  // Mantém a tela ligada (o bloqueio cai quando a aba fica oculta; renovamos ao voltar).
  const paired = board !== null;
  useEffect(() => {
    if (!paired) return;
    type Lock = { release(): Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Lock> } };
    let lock: Lock | null = null;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => undefined);
    };
  }, [paired]);

  // Estado do áudio (bloqueado/liberado pelo navegador)
  useEffect(() => onAudioStateChange(() => setAudioOk(audioUnlocked())), []);

  const unlock = useCallback(async () => {
    await unlockAudio();
    setAudioOk(audioUnlocked());
  }, []);

  // Tela inicial: com som já liberado (navegador em modo quiosque) segue direto;
  // sem toque, abre sozinha depois de alguns segundos (sem som, com aviso).
  useEffect(() => {
    if (!paired || started) return;
    if (audioOk) return setStarted(true);
    const t = setTimeout(() => setStarted(true), GATE_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [paired, started, audioOk]);

  // Interação (controle remoto, mouse ou toque): mostra os botões, libera o som
  useEffect(() => {
    let hideT: number | undefined;
    const show = () => {
      setIdle(false);
      setToolsShown(true);
      clearTimeout(hideT);
      hideT = window.setTimeout(() => {
        setToolsShown(false);
        setIdle(true);
        if (toolsRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      }, TOOLS_HIDE_MS);
    };
    const gesture = () => {
      show();
      if (!audioUnlocked()) void unlock();
    };
    const onKey = (e: KeyboardEvent) => {
      gesture();
      if (e.key === 'f' || e.key === 'F') void fs.toggle();
      // OK do controle sem nada focado: foca o primeiro botão da barra.
      if (e.key === 'Enter' && (document.activeElement === document.body || !document.activeElement)) {
        toolsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    };
    window.addEventListener('pointerdown', gesture);
    window.addEventListener('pointermove', show);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(hideT);
      window.removeEventListener('pointerdown', gesture);
      window.removeEventListener('pointermove', show);
      window.removeEventListener('keydown', onKey);
    };
  }, [fs, unlock]);

  // ------------------------------------------------ anúncios × painel

  const display = board?.display ?? DEFAULT_DISPLAY;
  const media = useMemo(() => (board?.media ?? []).filter((m) => !broken.has(m.id)), [board?.media, broken]);
  const adsOn = started && display.adsMode !== 'off' && media.length > 0;

  /** Depois da(s) chamada(s), o painel de pedidos fica na tela pelo tempo do modo. */
  const afterCall = useCallback(() => {
    const d = boardRef.current?.display ?? DEFAULT_DISPLAY;
    if (d.adsMode === 'off') return;
    setHold({ seconds: d.adsMode === 'ads_first' ? d.boardAfterCallSeconds : d.boardSeconds, at: Date.now() });
    setScene('board');
  }, []);

  useEffect(() => {
    if (!adsOn) {
      setScene('board');
      setHold(null);
      return;
    }
    if (call || scene !== 'board') return;
    // Carrossel: pedidos por N s. Anúncios primeiro: pedidos só depois de uma chamada.
    const secs = hold?.seconds ?? (display.adsMode === 'carousel' ? display.boardSeconds : 0);
    const t = setTimeout(() => {
      setHold(null);
      phaseStart.current = Date.now();
      setScene('ads');
    }, secs * 1000);
    return () => clearTimeout(t);
  }, [adsOn, call, scene, hold, display.adsMode, display.boardSeconds]);

  const onAdEnd = useCallback(() => {
    const d = boardRef.current?.display ?? DEFAULT_DISPLAY;
    // Carrossel: volta ao painel ao fim do item quando o tempo de anúncios passou
    // (um vídeo sempre termina antes).
    if (d.adsMode === 'carousel' && Date.now() - phaseStart.current >= d.adsSeconds * 1000) setScene('board');
  }, []);
  const onBroken = useCallback((id: string) => setBroken((s) => new Set(s).add(id)), []);

  // ------------------------------------------------ chamadas

  const processQueue = useCallback(async () => {
    if (busy.current) return;
    const next = queue.current.shift();
    if (!next) return;
    busy.current = true;
    setStarted(true); // chamada com a tela inicial aberta: mostra o painel
    setCall(next);
    setQueued(queue.current.length);
    const t0 = Date.now();
    try {
      await announce(next, boardRef.current);
    } catch {
      /* segue com o destaque visual */
    }
    await sleep(Math.max(3500, CALL_MIN_MS - (Date.now() - t0)));
    busy.current = false;
    if (queue.current.length) return void processQueue();
    setCall(null);
    setQueued(0);
    afterCall();
  }, [afterCall]);

  // Tempo real (conexão própria da TV, autenticada pelo cookie do pareamento)
  useEffect(() => {
    if (!paired) return;
    let ws: WebSocket | null = null;
    let stop = false;
    let attempt = 0;
    let retry: number | undefined;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        attempt = 0;
        setOffline(false);
        void load();
      };
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(String(m.data)) as { type: string; data?: unknown };
          if (e.type === 'pickup.call') {
            queue.current.push(e.data as TvCall);
            setQueued(queue.current.length);
            void processQueue();
            void load();
          } else if (e.type === 'tv.config') {
            setBroken(new Set()); // anúncios novos/alterados: tenta todos de novo
            void load();
          } else if (e.type === 'board.changed' || e.type === 'branding.updated' || e.type === 'device.revoked') void load();
        } catch {
          /* ignora */
        }
      };
      ws.onclose = (ev) => {
        if (stop) return;
        if (ev.code === 4401) return void load();
        setOffline(true);
        retry = window.setTimeout(connect, Math.min(15_000, 1000 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      stop = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [paired, load, processQueue]);

  // ------------------------------------------------ telas

  const startNow = async (fullscreen: boolean) => {
    if (fullscreen) void fs.enter(); // dentro do gesto, antes de qualquer espera
    await unlock();
    setStarted(true);
  };

  if (!board) {
    return (
      <div className="ptv">
        <div className="ptv-aurora" aria-hidden="true" />
        <StartScreen kind={pairing ? 'pairing' : 'loading'} pairing={pairing} offline={offline} fs={fs} onFullscreen={() => { void fs.toggle(); void unlock(); }} />
      </div>
    );
  }

  const boardVisible = !adsOn || scene === 'board';
  return (
    <div className={`ptv ${idle && started ? 'is-idle' : ''}`}>
      <div className="ptv-aurora" aria-hidden="true" />
      <div className={`ptv-scene ${boardVisible ? 'is-on' : ''}`} aria-hidden={!boardVisible}>
        <BoardScene board={board} offline={offline} offset={offset.current} tick={tick} />
      </div>
      {adsOn && (
        <div className={`ptv-scene ptv-scene-ads ${scene === 'ads' ? 'is-on' : ''}`} aria-hidden={scene !== 'ads'}>
          <AdsLayer items={media} active={scene === 'ads' && !call} videoSound={display.videoSound} videoVolume={display.videoVolume} onItemEnd={onAdEnd} onBroken={onBroken} />
          <div className="ptv-bug">
            <Logo branding={board.branding} size={Math.round(window.innerHeight * 0.05)} />
            <Clock offset={offset.current} className="ptv-bug-clock" />
          </div>
          {display.readyTicker && board.ready.length > 0 && <ReadyTicker entries={board.ready} />}
        </div>
      )}
      {call && <CallOverlay key={call.callId} call={call} queued={queued} pickupPlace={board.pickupPlace ?? 'no balcão'} />}
      {!started && <StartScreen kind="gate" board={board} fs={fs} onStart={startNow} />}
      {started && !audioOk && (
        <button type="button" className="ptv-audio-warn" onClick={() => void unlock()}>
          <VolumeX aria-hidden="true" />
          <span><strong>Som bloqueado</strong> Toque na tela ou aperte OK no controle</span>
        </button>
      )}
      {started && <Toolbar refEl={toolsRef} shown={toolsShown} fs={fs} audioOk={audioOk} onUnlock={() => void unlock()} />}
    </div>
  );
}

// ------------------------------------------------------------------ tela inicial

function StartScreen(props: {
  kind: 'loading' | 'pairing' | 'gate';
  pairing?: Pairing | null;
  offline?: boolean;
  board?: TvBoard;
  fs: Fullscreen;
  onFullscreen?: () => void;
  onStart?: (fullscreen: boolean) => void;
}) {
  const { kind, pairing, offline, board, fs, onFullscreen, onStart } = props;
  const [left, setLeft] = useState(GATE_SECONDS);
  useEffect(() => {
    if (kind !== 'gate') return;
    const i = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(i);
  }, [kind]);

  const fsButton = fs.supported ? (
    <button type="button" className="ptv-btn huge" onClick={onFullscreen} autoFocus={kind !== 'gate'}>
      {fs.on ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />} {fs.on ? 'Sair da tela cheia' : 'Tela cheia'}
    </button>
  ) : (
    <p className="ptv-start-hint">Use o botão de tela cheia do navegador da TV.</p>
  );

  return (
    <div className={`ptv-start ${kind === 'gate' ? 'is-gate' : ''}`}>
      <div className="ptv-start-card">
        {kind === 'loading' && (
          <>
            <span className="ptv-spinner" aria-hidden="true" />
            <h1>{offline ? 'Procurando o PC do bar…' : 'Carregando…'}</h1>
            {offline && <p>Confira se a TV está no mesmo Wi-Fi do computador do bar.</p>}
            <div className="ptv-start-actions">{fsButton}</div>
          </>
        )}
        {kind === 'pairing' && pairing && (
          <>
            <h1>Conectar esta TV ao RupBar</h1>
            <div className="ptv-code" aria-label={`Código ${pairing.code.split('').join(' ')}`}>{pairing.code}</div>
            <p>No computador do bar, abra <strong>Configurações → Conectar TV</strong> e digite este código.</p>
            <div className="ptv-start-actions">{fsButton}</div>
          </>
        )}
        {kind === 'gate' && board && (
          <>
            <Logo branding={board.branding} size={Math.round(window.innerHeight * 0.12)} />
            <h1>{board.branding.tradeName}</h1>
            <p>Toque na tela ou aperte <strong>OK</strong> no controle para iniciar o painel de retirada <strong>com som</strong>.</p>
            <div className="ptv-start-actions">
              <button type="button" className="ptv-btn huge primary" autoFocus onClick={() => onStart?.(false)}>
                <Play aria-hidden="true" /> Toque para iniciar
              </button>
              {fs.supported && (
                <button type="button" className="ptv-btn huge" onClick={() => onStart?.(true)}>
                  <Maximize aria-hidden="true" /> Iniciar em tela cheia
                </button>
              )}
            </div>
            <p className="ptv-start-hint">Sem toque, o painel abre sozinho em {left} s — sem som até alguém tocar na tela.</p>
          </>
        )}
      </div>
      <div className="ptv-sig">RupBar by Ruptix</div>
    </div>
  );
}

// ------------------------------------------------------------------ painel

function Clock({ offset, className = 'ptv-clock' }: { offset: number; className?: string }) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  return <div className={className}>{new Date(t + offset).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>;
}

/** Densidade do painel: quanto menos pedidos, maiores os nomes. */
const READY_LEVELS = [3, 6, 10, Infinity];
const READY_SHOW = [3, 6, 10, 15];
const PREP_LEVELS = [4, 10, Infinity];
const PREP_SHOW = [4, 10, 14];
const levelOf = (n: number, levels: number[]) => levels.findIndex((max) => n <= max);

function BoardScene({ board, offline, offset, tick }: { board: TvBoard; offline: boolean; offset: number; tick: number }) {
  const now = tick + offset;
  const place = board.pickupPlace ?? 'no balcão';
  const rl = levelOf(board.ready.length, READY_LEVELS);
  const pl = levelOf(board.preparing.length, PREP_LEVELS);
  const ready = board.ready.slice(0, READY_SHOW[rl]);
  const prep = board.preparing.slice(0, PREP_SHOW[pl]);
  const isFresh = (o: TvReadyEntry) => {
    const t = Date.parse(o.calledAt ?? o.readyAt ?? '');
    return Number.isFinite(t) && now - t < FRESH_MS;
  };
  return (
    <>
      <header className="ptv-head">
        <Logo branding={board.branding} size={Math.round(window.innerHeight * 0.08)} />
        <div className="ptv-brand">{board.branding.tradeName}</div>
        {offline && <span className="ptv-chip warn"><WifiOff aria-hidden="true" /> Reconectando…</span>}
        <Clock offset={offset} />
      </header>
      <main className="ptv-board">
        <section className="ptv-col ptv-col-prep" data-density={pl + 1} aria-label="Preparando">
          <header className="ptv-col-head">
            <ChefHat aria-hidden="true" />
            <h2>Preparando</h2>
            <span className="ptv-count">{board.preparing.length}</span>
          </header>
          {prep.length ? (
            <div className="ptv-grid">
              {prep.map((o, i) => <Tile key={o.number} entry={o} kind="prep" index={i} />)}
            </div>
          ) : (
            <div className="ptv-empty">Nenhum pedido em preparo</div>
          )}
          {board.preparing.length > prep.length && <div className="ptv-more">+ {board.preparing.length - prep.length} pedidos</div>}
        </section>
        <section className="ptv-col ptv-col-ready" data-density={rl + 1} aria-label="Pronto para retirar">
          <header className="ptv-col-head">
            <CircleCheck aria-hidden="true" />
            <h2>Pronto para retirar</h2>
            <span className="ptv-col-sub">Retire {place}</span>
          </header>
          {ready.length ? (
            <div className="ptv-grid">
              {ready.map((o, i) => <Tile key={o.number} entry={o} kind="ready" index={i} fresh={isFresh(o)} called={!!o.calledAt} />)}
            </div>
          ) : (
            <div className="ptv-empty ready">
              <CircleCheck aria-hidden="true" />
              Os pedidos prontos aparecem aqui
            </div>
          )}
          {board.ready.length > ready.length && <div className="ptv-more">+ {board.ready.length - ready.length} prontos</div>}
        </section>
      </main>
      <footer className="ptv-foot">RupBar by Ruptix</footer>
    </>
  );
}

/** Nome em destaque; comanda logo abaixo; número do pedido como rótulo pequeno. */
function Tile({ entry, kind, index, fresh, called }: { entry: TvEntry; kind: 'prep' | 'ready'; index: number; fresh?: boolean; called?: boolean }) {
  const name = (entry.displayName || entry.name || '').trim();
  const comanda = entry.comandaDisplayNumber;
  const hero = name || (comanda !== null ? `Comanda ${comanda}` : `Pedido ${entry.number}`);
  const showOrder = !!name || comanda !== null;
  return (
    <div className={`ptv-tile ${kind}${fresh ? ' is-fresh' : ''}${[...hero].length > 11 ? ' is-long' : ''}`} style={{ animationDelay: `${Math.min(index, 8) * 70}ms` }}>
      {kind === 'ready' && <span className="ptv-tile-shine" aria-hidden="true" />}
      <div className="ptv-tile-name">{hero}</div>
      <div className="ptv-tile-meta">
        {name && comanda !== null && <span className="ptv-tile-comanda">Comanda <b>{comanda}</b></span>}
        {showOrder && <span className="ptv-tile-order"><span className="ptv-order-word">Pedido </span>{entry.number}</span>}
        {called && <BellRing className="ptv-tile-bell" aria-label="Chamado" />}
      </div>
    </div>
  );
}

/** Faixa com os nomes prontos sobre os anúncios (rola somente se não couber). */
function ReadyTicker({ entries }: { entries: TvReadyEntry[] }) {
  const track = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLSpanElement>(null);
  const [dur, setDur] = useState<number | null>(null);
  const key = entries.map((e) => `${e.number}:${e.displayName}:${e.comandaDisplayNumber}`).join('|');
  useLayoutEffect(() => {
    const t = track.current;
    const c = copy.current;
    if (!t || !c) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setDur(c.offsetWidth > t.clientWidth && !reduce ? Math.max(10, c.offsetWidth / 90) : null);
  }, [key]);
  const items = entries.map((e) => (
    <span key={e.number} className="ptv-ticker-item">
      {e.displayName || e.name || (e.comandaDisplayNumber !== null ? `Comanda ${e.comandaDisplayNumber}` : `Pedido ${e.number}`)}
      {(e.displayName || e.name) && e.comandaDisplayNumber !== null && <small>Comanda {e.comandaDisplayNumber}</small>}
    </span>
  ));
  return (
    <div className="ptv-ticker" role="status">
      <div className="ptv-ticker-label"><CircleCheck aria-hidden="true" /> Pronto para retirar</div>
      <div className="ptv-ticker-track" ref={track}>
        <div className={`ptv-ticker-run ${dur ? 'is-moving' : ''}`} style={dur ? ({ '--t': `${dur}s` } as CSSProperties) : undefined}>
          <span className="ptv-ticker-copy" ref={copy}>{items}</span>
          {dur && <span className="ptv-ticker-copy" aria-hidden="true">{items}</span>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ chamada

function CallOverlay({ call, queued, pickupPlace }: { call: TvCall; queued: number; pickupPlace: string }) {
  const name = (call.customerDisplayName || call.customerFirstName || '').trim();
  const comanda = call.comandaDisplayNumber ?? null;
  const hero = name || (comanda !== null ? `Comanda ${comanda}` : `Pedido ${call.number}`);
  const nameStyle = { '--len': [...hero].length } as CSSProperties;
  return (
    <div className="ptv-call" role="alert" aria-live="assertive">
      <div className="ptv-call-rings" aria-hidden="true"><span /><span /><span /></div>
      <div className="ptv-call-card">
        <div className="ptv-call-glow" aria-hidden="true" />
        <div className="ptv-call-label"><BellRing aria-hidden="true" /> {call.test ? 'Teste de som' : 'Pedido pronto'}</div>
        <div className="ptv-call-name" style={nameStyle}>{hero}</div>
        {name && comanda !== null && <div className="ptv-call-comanda">Comanda <strong>{comanda}</strong></div>}
        <div className="ptv-call-place">Retire {pickupPlace}</div>
        {!call.test && (name || comanda !== null) && <div className="ptv-call-order">Pedido nº {call.number}</div>}
      </div>
      {queued > 0 && <div className="ptv-call-queue">+{queued} {queued === 1 ? 'chamada' : 'chamadas'} na fila</div>}
    </div>
  );
}

// ------------------------------------------------------------------ barra de botões

function Toolbar({ refEl, shown, fs, audioOk, onUnlock }: { refEl: RefObject<HTMLDivElement | null>; shown: boolean; fs: Fullscreen; audioOk: boolean; onUnlock: () => void }) {
  const tab = shown ? 0 : -1;
  return (
    <div ref={refEl} className={`ptv-tools ${shown ? 'is-shown' : ''}`} aria-hidden={!shown}>
      {fs.supported && (
        <button type="button" className="ptv-btn" tabIndex={tab} onClick={() => void fs.toggle()}>
          {fs.on ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />} {fs.on ? 'Sair da tela cheia' : 'Tela cheia'}
        </button>
      )}
      <button type="button" className={`ptv-btn ${audioOk ? '' : 'warn'}`} tabIndex={tab} onClick={onUnlock}>
        {audioOk ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />} {audioOk ? 'Som ativo' : 'Ativar som'}
      </button>
    </div>
  );
}
