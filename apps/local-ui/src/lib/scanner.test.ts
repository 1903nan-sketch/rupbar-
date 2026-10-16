import { afterEach, describe, expect, it } from 'vitest';
import { scannerKeydown, subscribeBarcode } from './scanner';

const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault() {}, stopPropagation() {} });

/** Digita `text` com `gap` ms entre teclas e termina com Enter. */
function type(text: string, gap: number, start = 1_000): boolean {
  let t = start;
  for (const ch of text) {
    scannerKeydown(key(ch), t);
    t += gap;
  }
  return scannerKeydown(key('Enter'), t);
}

let off: (() => void) | null = null;
afterEach(() => off?.());

describe('leitor de código de barras', () => {
  it('reconhece a rajada do leitor e entrega ao inscrito mais recente que tratar', () => {
    const got: string[] = [];
    const offA = subscribeBarcode((c) => (got.push(`A:${c}`), true));
    const offB = subscribeBarcode((c) => (c.startsWith('RB') ? (got.push(`B:${c}`), true) : false));
    off = () => (offA(), offB());
    expect(type('7891234567895', 8)).toBe(true);
    expect(type('RB2610160042', 8, 5_000)).toBe(true);
    expect(got).toEqual(['A:7891234567895', 'B:RB2610160042']);
  });

  it('pessoa digitando (devagar) ou código curto não é leitura', () => {
    const got: string[] = [];
    off = subscribeBarcode((c) => (got.push(c), true));
    expect(type('7891234567895', 120)).toBe(false);
    expect(type('123', 5, 9_000)).toBe(false);
    expect(got).toEqual([]);
  });
});
