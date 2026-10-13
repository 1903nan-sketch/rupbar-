import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TvMediaItem } from './types';

interface Props {
  /** Anúncios disponíveis (já sem os que falharam). */
  items: TvMediaItem[];
  /** Visível e tocando. Falso durante chamadas e enquanto o painel de pedidos aparece. */
  active: boolean;
  videoSound: boolean;
  videoVolume: number;
  /** Fim de cada item (o modo carrossel decide se volta ao painel). */
  onItemEnd: () => void;
  /** Arquivo com erro: a TV pula e não tenta de novo nesta sessão. */
  onBroken: (id: string) => void;
}

interface Slot {
  id: string;
  key: number;
}

/** Vídeo sem avanço por este tempo (rede/arquivo travado) é pulado. */
const STALL_MS = 20_000;
const CROSSFADE_MS = 1100;

/**
 * Reproduz os anúncios em sequência com transição suave. Fica montado mesmo
 * quando o painel de pedidos está na tela: o vídeo pausa e continua de onde parou.
 */
export function AdsLayer({ items, active, videoSound, videoVolume, onItemEnd, onBroken }: Props) {
  const [cur, setCur] = useState<Slot | null>(null);
  const [old, setOld] = useState<Slot | null>(null);
  const seq = useRef(0);
  const itemsRef = useRef(items);
  const prevItems = useRef<TvMediaItem[]>([]);
  const curRef = useRef(cur);
  curRef.current = cur;
  const cb = useRef({ onItemEnd, onBroken });
  cb.current = { onItemEnd, onBroken };

  // Lista mudou (anúncio novo, desativado, excluído ou com erro): mantém o atual
  // se ele continua; senão segue para o próximo que ainda existe.
  useEffect(() => {
    itemsRef.current = items;
    const before = prevItems.current;
    prevItems.current = items;
    const c = curRef.current;
    if (!items.length) return setCur(null);
    if (c && items.some((m) => m.id === c.id)) return;
    const from = c ? before.findIndex((m) => m.id === c.id) : -1;
    let next = items[0]!;
    for (let k = 1; from >= 0 && k <= before.length; k++) {
      const cand = before[(from + k) % before.length];
      const found = cand && items.find((m) => m.id === cand.id);
      if (found) {
        next = found;
        break;
      }
    }
    setCur({ id: next.id, key: ++seq.current });
  }, [items]);

  const advance = useCallback((ended: boolean) => {
    const list = itemsRef.current;
    const c = curRef.current;
    if (ended) cb.current.onItemEnd();
    if (!list.length) return;
    const i = c ? list.findIndex((m) => m.id === c.id) : -1;
    const next = list[(i + 1) % list.length]!;
    setOld(c);
    setCur({ id: next.id, key: ++seq.current });
  }, []);

  useEffect(() => {
    if (!old) return;
    const t = setTimeout(() => setOld(null), CROSSFADE_MS);
    return () => clearTimeout(t);
  }, [old]);

  // Pré-carrega a próxima foto para a troca ser instantânea.
  useEffect(() => {
    if (!cur || items.length < 2) return;
    const i = items.findIndex((m) => m.id === cur.id);
    const next = items[(i + 1) % items.length];
    if (next?.kind === 'image') new Image().src = next.url;
  }, [cur, items]);

  const find = (id: string) => items.find((m) => m.id === id) ?? prevItems.current.find((m) => m.id === id);
  const oldItem = old && old.key !== cur?.key ? find(old.id) : undefined;
  const curItem = cur ? find(cur.id) : undefined;

  return (
    <div className={`ptv-ads ${active ? 'is-active' : ''}`}>
      {old && oldItem && <AdSlot key={old.key} item={oldItem} active={false} sound={false} volume={0} />}
      {cur && curItem && (
        <AdSlot
          key={cur.key}
          item={curItem}
          active={active}
          sound={videoSound}
          volume={videoVolume}
          onDone={() => advance(true)}
          onSkip={() => advance(false)}
          onError={() => cb.current.onBroken(curItem.id)}
        />
      )}
    </div>
  );
}

interface SlotProps {
  item: TvMediaItem;
  active: boolean;
  sound: boolean;
  volume: number;
  onDone?: () => void;
  onSkip?: () => void;
  onError?: () => void;
}

function AdSlot(props: SlotProps) {
  return props.item.kind === 'video' ? <AdVideo {...props} /> : <AdImage {...props} />;
}

function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** Foto: exibida pelo tempo configurado; o tempo pausa junto com os anúncios. */
function AdImage({ item, active, onDone, onError }: SlotProps) {
  const remaining = useRef(item.durationSeconds * 1000);
  const done = useLatest(onDone);
  useEffect(() => {
    if (!active || !done.current) return;
    const started = Date.now();
    const t = setTimeout(() => done.current?.(), Math.max(0, remaining.current));
    return () => {
      clearTimeout(t);
      remaining.current -= Date.now() - started;
    };
  }, [active, done]);
  const style = { '--dur': `${item.durationSeconds + 2}s` } as CSSProperties;
  return (
    <div className="ptv-ad ptv-ad-image" style={style}>
      <img className="ptv-ad-backdrop" src={item.url} alt="" aria-hidden="true" />
      <img className="ptv-ad-media" src={item.url} alt={item.title} onError={() => onError?.()} />
    </div>
  );
}

/** Vídeo: toca até o fim; pausa nas chamadas e continua depois. */
function AdVideo({ item, active, sound, volume, onDone, onSkip, onError }: SlotProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const progress = useRef(Date.now());
  const handlers = useLatest({ onSkip, onError });

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = !sound;
    v.volume = Math.max(0, Math.min(1, volume / 100));
  }, [sound, volume]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!active) {
      v.pause();
      return;
    }
    progress.current = Date.now();
    v.play().catch((err: DOMException) => {
      if (err?.name === 'AbortError') return; // pausado antes de começar (chamada)
      if (err?.name === 'NotAllowedError' && !v.muted) {
        // o navegador recusou som sem gesto: toca sem som
        v.muted = true;
        v.play().catch(() => handlers.current.onSkip?.());
        return;
      }
      handlers.current.onError?.();
    });
    const watchdog = setInterval(() => {
      if (!v.paused && Date.now() - progress.current > STALL_MS) handlers.current.onSkip?.();
    }, 5000);
    return () => clearInterval(watchdog);
  }, [active, handlers]);

  return (
    <div className="ptv-ad ptv-ad-video">
      <video
        ref={ref}
        className="ptv-ad-media"
        src={item.url}
        playsInline
        preload="auto"
        muted={!sound}
        onEnded={() => onDone?.()}
        onError={() => onError?.()}
        onTimeUpdate={() => (progress.current = Date.now())}
      />
    </div>
  );
}
