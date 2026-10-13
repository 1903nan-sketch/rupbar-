import { describe, expect, it } from 'vitest';
import { contrastOn, dayRange, elapsed, fmtDecimal, fromInputDate, parseDecimal, toInputDate } from './format';

describe('formatação da interface', () => {
  it('escolhe texto legível sobre a cor do estabelecimento', () => {
    expect(contrastOn('#0A84FF')).toBe('#ffffff');
    expect(contrastOn('#FFD60A')).toBe('#1d1d1f');
    expect(contrastOn('inválida')).toBe('#ffffff');
  });
  it('interpreta decimais no padrão brasileiro', () => {
    expect(parseDecimal('1,5')).toBe(1.5);
    expect(parseDecimal('1.000,25')).toBe(1000.25);
    expect(parseDecimal('abc')).toBeNull();
    expect(fmtDecimal(12.5)).toBe('12,5');
  });
  it('período local de um dia e tempo decorrido', () => {
    const d = fromInputDate('2026-03-14');
    expect(toInputDate(d)).toBe('2026-03-14');
    const r = dayRange(d);
    expect(Date.parse(r.to) - Date.parse(r.from)).toBe(86_400_000);
    const now = Date.parse('2026-03-14T23:30:00Z');
    expect(elapsed('2026-03-14T23:29:50Z', now)).toBe('agora');
    expect(elapsed('2026-03-14T23:05:00Z', now)).toBe('25 min');
    expect(elapsed('2026-03-14T21:10:00Z', now)).toBe('2 h 20');
  });
});
