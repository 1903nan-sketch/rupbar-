/**
 * Som da TV de retirada, gerado localmente (sem arquivos nem internet):
 *  - toque de atenção ALTO (arpejo de sinos com compressor e limitador);
 *  - voz do Windows (WAV do servidor) tocada pelo WebAudio, com ganho extra;
 *  - voz do navegador (speechSynthesis) como alternativa.
 *
 * Navegadores só liberam áudio depois de um gesto (toque, clique ou OK no
 * controle): `unlockAudio()` deve ser chamado dentro desse gesto.
 */

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
const stateListeners = new Set<() => void>();

export function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor: AudioCtor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    ctx.onstatechange = () => stateListeners.forEach((l) => l());
    return ctx;
  } catch {
    return null;
  }
}

/** true quando o navegador já permite tocar som sem novo gesto. */
export function audioUnlocked(): boolean {
  return audioContext()?.state === 'running';
}

/**
 * resume() com prazo: sem gesto do usuário, o Chrome deixa a promessa pendente
 * para sempre — esperar por ela travaria a fila de chamadas.
 */
async function resumeWithin(c: AudioContext, ms: number): Promise<void> {
  await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
}

export function onAudioStateChange(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => {
    stateListeners.delete(fn);
  };
}

let silentUrl: string | null = null;
/** WAV silencioso (100 ms) para liberar o elemento <audio> em navegadores de TV. */
function silentWav(): string {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silentUrl;
}

/**
 * Libera o áudio. Precisa ser chamado dentro de um gesto do usuário.
 * Devolve true se o WebAudio ficou ativo.
 */
export async function unlockAudio(): Promise<boolean> {
  const c = audioContext();
  if (!c) return false;
  await resumeWithin(c, 1000);
  try {
    // Alguns navegadores só liberam de fato depois de tocar algo.
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* ignora */
  }
  try {
    // "Aquece" a voz do navegador dentro do gesto (Chrome exige ativação).
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis?.speak(u);
  } catch {
    /* sem voz no navegador */
  }
  try {
    const a = new Audio(silentWav());
    a.volume = 0;
    await Promise.race([a.play(), new Promise((r) => setTimeout(r, 1000))]);
  } catch {
    /* ignora */
  }
  return c.state === 'running';
}

// Função (e não comparação direta) para o TypeScript não fixar o estado após o await.
const isRunning = (c: AudioContext) => c.state === 'running';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Cadeia de saída: pré-ganho → compressor (som cheio, "alto") → volume →
 * limitador (evita distorção) → alto-falantes. Desfeita ao terminar.
 */
function outputChain(c: AudioContext, volume: number, drive: number) {
  const pre = c.createGain();
  pre.gain.value = drive;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 10;
  comp.ratio.value = 8;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  const vol = c.createGain();
  vol.gain.value = clamp01(volume) * 0.98;
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  pre.connect(comp).connect(vol).connect(limiter).connect(c.destination);
  return {
    input: pre,
    dispose: () => {
      try {
        pre.disconnect();
        limiter.disconnect();
      } catch {
        /* já desconectado */
      }
    },
  };
}

/** Notas do arpejo (Mi maior, ascendente, a última sustentada). */
const NOTES: { f: number; at: number; hold?: boolean }[] = [
  { f: 659.25, at: 0 },
  { f: 987.77, at: 0.13 },
  { f: 1318.51, at: 0.26 },
  { f: 1661.22, at: 0.39, hold: true },
];
/** Parciais de sino: [multiplicador de frequência, ganho, tipo]. */
const PARTIALS: [number, number, OscillatorType][] = [
  [1, 0.55, 'sine'],
  [1, 0.22, 'triangle'],
  [2, 0.2, 'sine'],
  [2.76, 0.1, 'sine'],
  [4.07, 0.05, 'sine'],
];
const BLOCK_SECONDS = 1.35;

/**
 * Toque de atenção da chamada: arpejo de sinos repetido `times` vezes, no
 * volume indicado (0–1). Resolve quando o som termina.
 */
export async function attentionChime(times = 2, volume = 1): Promise<void> {
  const c = audioContext();
  if (!c || volume <= 0) return;
  if (!isRunning(c)) {
    await resumeWithin(c, 300);
    if (!isRunning(c)) return; // ainda bloqueado: sem gesto do usuário
  }
  const out = outputChain(c, volume, 2.2);
  const t0 = c.currentTime + 0.05;
  const n = Math.max(1, Math.min(5, Math.round(times)));
  for (let k = 0; k < n; k++) {
    for (const note of NOTES) {
      const start = t0 + k * BLOCK_SECONDS + note.at;
      const decay = note.hold ? 1.5 : 0.85;
      for (const [mult, gain, type] of PARTIALS) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = type;
        o.frequency.value = note.f * mult;
        const d = mult > 1 ? decay * 0.6 : decay;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.linearRampToValueAtTime(gain, start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, start + d);
        o.connect(g).connect(out.input);
        o.start(start);
        o.stop(start + d + 0.05);
      }
    }
  }
  const total = (n - 1) * BLOCK_SECONDS + NOTES[NOTES.length - 1]!.at + 1.6;
  await sleep(total * 1000 + 50);
  out.dispose();
}

/** WAV da voz do Windows (servidor) pelo WebAudio, com ganho extra. */
export async function playVoiceUrl(url: string, volume: number): Promise<boolean> {
  const c = audioContext();
  if (c && c.state === 'running') {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return false;
      const buf = await c.decodeAudioData(await res.arrayBuffer());
      const out = outputChain(c, volume, 1.6);
      await new Promise<void>((resolve) => {
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(out.input);
        src.onended = () => resolve();
        src.start();
        setTimeout(resolve, buf.duration * 1000 + 1500);
      });
      out.dispose();
      return true;
    } catch {
      /* tenta pelo elemento <audio> */
    }
  }
  return new Promise((resolve) => {
    const a = new Audio(url);
    a.volume = clamp01(volume);
    a.onended = () => resolve(true);
    a.onerror = () => resolve(false);
    a.play().catch(() => resolve(false));
    // proteção: um anúncio nunca segura a fila de chamadas por mais de 20 s
    setTimeout(() => {
      a.pause();
      resolve(true);
    }, 20_000);
  });
}

async function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return now;
  // Em vários navegadores a lista chega depois, de forma assíncrona.
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener?.('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

/** Voz do navegador em português (se houver). */
export async function speakBrowser(text: string, volume: number): Promise<boolean> {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  const voices = await loadVoices();
  const voice = voices.find((v) => v.lang === 'pt-BR' && v.localService) ?? voices.find((v) => v.lang?.replace('_', '-').startsWith('pt'));
  if (!voice) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = 'pt-BR';
    u.rate = 0.95;
    u.volume = clamp01(volume);
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    synth.cancel();
    synth.speak(u);
    // Alguns navegadores de TV não disparam "onend".
    setTimeout(() => finish(true), 4000 + text.length * 90);
  });
}

/** Alerta curto e discreto (painel da cozinha/balcão). */
export function chime(times = 1): void {
  try {
    const c = audioContext();
    if (!c) return;
    void c.resume();
    for (let k = 0; k < times; k++) {
      [880, 1318.5].forEach((freq, i) => {
        const t = c.currentTime + k * 0.7 + i * 0.22;
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(g).connect(c.destination);
        o.start(t);
        o.stop(t + 0.65);
      });
    }
  } catch {
    /* sem áudio disponível */
  }
}
