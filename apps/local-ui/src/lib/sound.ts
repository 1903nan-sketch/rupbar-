/**
 * Alertas sonoros fortes, gerados no próprio navegador (sem arquivos de áudio):
 * vários tons com compressor para soar alto mesmo em caixas de som simples.
 * Navegadores só liberam som depois de um toque/clique na página.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Chame em um clique/toque para liberar o som. */
export async function unlockSound(): Promise<boolean> {
  const a = audio();
  if (!a) return false;
  if (a.state === 'suspended') await a.resume().catch(() => undefined);
  return a.state === 'running';
}

export function soundUnlocked(): boolean {
  return audio()?.state === 'running';
}

type Pattern = 'order' | 'call' | 'warning';

const PATTERNS: Record<Pattern, { freq: number; at: number; dur: number; type: OscillatorType }[]> = {
  // novo pedido: "plim-plim-PLIM" ascendente
  order: [
    { freq: 880, at: 0, dur: 0.16, type: 'square' },
    { freq: 1175, at: 0.18, dur: 0.16, type: 'square' },
    { freq: 1568, at: 0.36, dur: 0.34, type: 'square' },
  ],
  // chamada de cliente: campainha dupla
  call: [
    { freq: 1319, at: 0, dur: 0.22, type: 'triangle' },
    { freq: 988, at: 0.24, dur: 0.42, type: 'triangle' },
  ],
  warning: [
    { freq: 660, at: 0, dur: 0.2, type: 'sawtooth' },
    { freq: 660, at: 0.3, dur: 0.2, type: 'sawtooth' },
  ],
};

/**
 * Toca o alerta `times` vezes. `volume` de 0 a 1 (1 = bem alto).
 * Retorna false se o som ainda está bloqueado pelo navegador.
 */
export function playAlert(pattern: Pattern = 'order', { times = 2, volume = 1 }: { times?: number; volume?: number } = {}): boolean {
  const a = audio();
  if (!a) return false;
  if (a.state === 'suspended') {
    void a.resume();
    if (a.state === 'suspended') return false;
  }
  const comp = a.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 8;
  comp.ratio.value = 6;
  const master = a.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.95;
  comp.connect(master).connect(a.destination);
  const notes = PATTERNS[pattern];
  const length = Math.max(...notes.map((n) => n.at + n.dur)) + 0.25;
  const t0 = a.currentTime + 0.02;
  for (let r = 0; r < Math.max(1, times); r++) {
    for (const n of notes) {
      const start = t0 + r * length + n.at;
      const osc = a.createOscillator();
      const g = a.createGain();
      osc.type = n.type;
      osc.frequency.setValueAtTime(n.freq, start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.9, start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(g).connect(comp);
      osc.start(start);
      osc.stop(start + n.dur + 0.05);
    }
  }
  return true;
}
