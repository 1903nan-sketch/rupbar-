/** Geometria dos gráficos SVG (sem bibliotecas). */

/** Curva cúbica monotônica (Fritsch–Carlson): suave e sem ultrapassar os dados. */
export function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (!n) return '';
  const r = (v: number) => Math.round(v * 100) / 100;
  if (n === 1) return `M${r(pts[0]![0])},${r(pts[0]![1])}`;
  const x = pts.map((p) => p[0]);
  const y = pts.map((p) => p[1]);
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = x[i + 1]! - x[i]!;
    m[i] = dx[i] ? (y[i + 1]! - y[i]!) / dx[i]! : 0;
  }
  const t: number[] = new Array(n).fill(0);
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${r(x[0]!)},${r(y[0]!)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${r(x[i]! + h)},${r(y[i]! + t[i]! * h)},${r(x[i + 1]! - h)},${r(y[i + 1]! - t[i + 1]! * h)},${r(x[i + 1]!)},${r(y[i + 1]!)}`;
  }
  return d;
}

/** Escala "redonda" para o eixo Y: passos de 1, 2, 2,5 ou 5 × 10ⁿ. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1, 2, 3, 4].map((i) => i * 2500); // R$ 0 – R$ 100 (centavos)
  const raw = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * pow).find((s) => s >= raw) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}
