import { useEffect, useRef } from 'react';

/**
 * Leitor de código de barras USB (funciona como teclado): "digita" o código
 * muito rápido e termina com Enter. Um único ouvinte global reconhece essa
 * rajada e entrega o código a quem estiver inscrito, do mais recente para o
 * mais antigo, até alguém tratar. Quando alguém trata, o texto que o leitor
 * digitou no campo em foco é desfeito e o Enter não chega ao formulário.
 *
 * Campos marcados com data-barcode="field" (ex.: "Código de barras" no
 * cadastro do produto) recebem o código normalmente.
 */
type Handler = (code: string) => boolean;

/** Códigos mais curtos que isso são digitação comum (EAN-8 tem 8). */
const MIN_LENGTH = 6;
/** Intervalo máximo entre teclas de uma mesma leitura (ms). */
const MAX_GAP_MS = 60;
/** Média máxima entre teclas para ser leitor, e não uma pessoa digitando (ms). */
const MAX_AVG_MS = 35;

const handlers: Handler[] = [];
let installed = false;
let buffer = '';
let first = 0;
let last = 0;
let field: HTMLInputElement | HTMLTextAreaElement | null = null;
let before = '';

function editable(el: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (typeof HTMLInputElement === 'undefined') return null;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

/** Volta o valor do campo (controlado pelo React) para antes da leitura. */
function restore(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  if (el.value === value) return;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Reconhece a rajada do leitor; exportado para testes. */
export function scannerKeydown(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target' | 'preventDefault' | 'stopPropagation'>, now: number): boolean {
  if (!handlers.length) return false;
  const target = e.target as HTMLElement | null;
  if (typeof target?.closest === 'function' && target.closest('[data-barcode="field"]')) {
    buffer = '';
    return false;
  }
  if (e.key === 'Enter') {
    const code = buffer;
    const avg = (last - first) / Math.max(1, code.length - 1);
    const scanned = code.length >= MIN_LENGTH && now - last <= MAX_GAP_MS * 2 && avg <= MAX_AVG_MS;
    const el = field;
    const prev = before;
    buffer = '';
    if (!scanned) return false;
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i]!(code)) {
        e.preventDefault();
        e.stopPropagation();
        if (el) restore(el, prev);
        return true;
      }
    }
    return false;
  }
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
    buffer = '';
    return false;
  }
  if (!buffer || now - last > MAX_GAP_MS) {
    buffer = e.key;
    first = now;
    field = editable(e.target);
    before = field?.value ?? '';
  } else {
    buffer += e.key;
  }
  last = now;
  return false;
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', (e) => void scannerKeydown(e, performance.now()), true);
}

/** Inscreve um receptor de códigos; devolve a função que cancela a inscrição. */
export function subscribeBarcode(handler: Handler): () => void {
  install();
  handlers.push(handler);
  return () => {
    const i = handlers.lastIndexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/**
 * Recebe os códigos bipados enquanto o componente estiver na tela. O handler
 * devolve true quando tratou o código (os de baixo não recebem).
 */
export function useBarcodeScanner(handler: Handler, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return subscribeBarcode((code) => ref.current(code));
  }, [enabled]);
}
