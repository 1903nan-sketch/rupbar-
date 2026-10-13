import { describe, expect, it } from 'vitest';
import {
  costModes, defaultSell, draftFromPackaging, entryPayload, modeLabel, PACK_DEFAULTS, packagingFromDraft, presentationsFor, priceLabel,
  qtyDraftFrom, qtyOf,
} from './stock-units';

const fardo = { measure: 'unit' as const, packageQty: 12_000, packageLabel: 'fardo', unitLabel: 'lata' };
const garrafa = { measure: 'volume' as const, packageQty: 1_000_000, packageLabel: 'garrafa', unitLabel: null };

describe('como você compra', () => {
  it('converte cada opção no cadastro do produto', () => {
    expect(packagingFromDraft(PACK_DEFAULTS.single)).toEqual({ ok: true, value: { measure: 'unit', packageQty: 1000, packageLabel: 'unidade', unitLabel: 'unidade' } });
    expect(packagingFromDraft(PACK_DEFAULTS.pack)).toEqual({ ok: true, value: fardo });
    expect(packagingFromDraft({ ...PACK_DEFAULTS.bottle, size: 750 })).toEqual({ ok: true, value: { measure: 'volume', packageQty: 750_000, packageLabel: 'garrafa', unitLabel: null } });
    expect(packagingFromDraft(PACK_DEFAULTS.bag)).toEqual({ ok: true, value: { measure: 'mass', packageQty: 50_000, packageLabel: 'pacote', unitLabel: null } });
  });

  it('explica o que falta em vez de aceitar embalagem inválida', () => {
    const one = packagingFromDraft({ ...PACK_DEFAULTS.pack, perPack: 1 });
    expect(one.ok).toBe(false);
    expect(!one.ok && one.error).toContain('Unidade avulsa');
    expect(packagingFromDraft({ ...PACK_DEFAULTS.bottle, size: null }).ok).toBe(false);
  });

  it('reabre o cadastro existente no mesmo formato', () => {
    expect(draftFromPackaging(fardo)).toMatchObject({ buyMode: 'pack', perPack: 12, packageLabel: 'fardo', unitLabel: 'lata' });
    expect(draftFromPackaging(garrafa)).toMatchObject({ buyMode: 'bottle', size: 1000, packageLabel: 'garrafa' });
    // Produto antigo por unidade: o nome da embalagem vira o nome da unidade.
    expect(draftFromPackaging({ measure: 'unit', packageQty: 1000, packageLabel: 'lata' })).toMatchObject({ buyMode: 'single', unitLabel: 'lata' });
  });
});

describe('como você vende', () => {
  it('cria a apresentação certa para cada jeito de vender', () => {
    expect(presentationsFor({ mode: 'unit', dose: null, priceCents: 900 }, fardo)).toEqual({ ok: true, value: [{ name: 'Unidade', priceCents: 900, components: [{ productId: null, qty: 1000 }] }] });
    expect(presentationsFor({ ...defaultSell('bottle'), priceCents: 2990 }, garrafa)).toEqual({ ok: true, value: [{ name: 'Dose 50 ml', priceCents: 2990, components: [{ productId: null, qty: 50_000 }] }] });
    expect(presentationsFor({ mode: 'unit', dose: null, priceCents: 15_000 }, garrafa)).toEqual({ ok: true, value: [{ name: 'Garrafa', priceCents: 15_000, components: [{ productId: null, qty: 1_000_000 }] }] });
    expect(presentationsFor(defaultSell('bag'), garrafa)).toEqual({ ok: true, value: [] });
    expect(presentationsFor({ mode: 'dose', dose: 2000, priceCents: 100 }, garrafa).ok).toBe(false);
    expect(presentationsFor({ mode: 'unit', dose: null, priceCents: null }, fardo).ok).toBe(false);
    expect(priceLabel('unit', fardo)).toBe('Preço de 1 lata');
    expect(priceLabel('dose', garrafa)).toBe('Preço da dose');
  });
});

describe('quantidade e custo', () => {
  it('interpreta o número no modo escolhido', () => {
    expect(qtyOf({ amount: 2, mode: 'pack' }, fardo)).toBe(24_000);
    expect(qtyOf({ amount: 2, mode: 'unit' }, fardo)).toBe(2_000);
    expect(qtyOf({ amount: null, mode: 'unit' }, fardo)).toBe(0);
    expect(entryPayload({ amount: 2, mode: 'pack' }, fardo)).toEqual({ packages: 2 });
    expect(entryPayload({ amount: 30, mode: 'unit' }, fardo)).toEqual({ qty: 30_000 });
    expect(qtyDraftFrom(24_000, fardo)).toEqual({ amount: 2, mode: 'pack' });
    expect(qtyDraftFrom(6_000, fardo)).toEqual({ amount: 6, mode: 'unit' });
    expect(qtyDraftFrom(0, fardo)).toEqual({ amount: null, mode: 'pack' });
  });

  it('nomeia os botões com as palavras do produto', () => {
    expect(modeLabel('pack', fardo)).toBe('Fardos');
    expect(modeLabel('unit', fardo)).toBe('Latas');
    expect(modeLabel('unit', garrafa)).toBe('ml');
    expect(costModes(fardo).map((m) => m.label)).toEqual(['Por fardo', 'Por lata', 'Total']);
    expect(costModes(garrafa).map((m) => m.label)).toEqual(['Por garrafa', 'Total']);
  });
});
