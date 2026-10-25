/**
 * Regras da interface para "como compra" × "como vende" (sem React, testáveis).
 * As conversões de quantidade ficam em @rupbar/core (packaging.ts).
 */
import {
  bigUnitName, buyModeOf, DEFAULT_PACKAGE_LABEL, KILO, isFemininePt, MILLI, packName, qtyFrom, unitName, amountIn, preferredMode,
  type BuyMode, type CostMode, type Measure, type Packaging, type QtyMode, type SellMode,
} from '@rupbar/core';

export const cap = (s: string) => (s ? s[0]!.toLocaleUpperCase('pt-BR') + s.slice(1) : s);

/** Rascunho do "Como você compra este produto?" com os números como a pessoa digita. */
export interface PackDraft {
  buyMode: BuyMode;
  /** Unidades em cada fardo/caixa (modo pack). */
  perPack: number | null;
  /** Tamanho da garrafa (ml) ou do pacote (g). */
  size: number | null;
  packageLabel: string;
  unitLabel: string;
}

export const PACK_DEFAULTS: Record<BuyMode, PackDraft> = {
  single: { buyMode: 'single', perPack: null, size: null, packageLabel: '', unitLabel: 'unidade' },
  pack: { buyMode: 'pack', perPack: 12, size: null, packageLabel: 'fardo', unitLabel: 'lata' },
  bottle: { buyMode: 'bottle', perPack: null, size: 1000, packageLabel: 'garrafa', unitLabel: '' },
  bag: { buyMode: 'bag', perPack: null, size: 50, packageLabel: 'pacote', unitLabel: '' },
};

export const BUY_MEASURE: Record<BuyMode, Measure> = { single: 'unit', pack: 'unit', bottle: 'volume', bag: 'mass' };

export function draftFromPackaging(p: Packaging): PackDraft {
  const buyMode = buyModeOf(p);
  const units = p.packageQty / MILLI;
  const pkg = p.packageLabel?.trim() ?? '';
  const unit = p.unitLabel?.trim() ?? '';
  return {
    buyMode,
    perPack: buyMode === 'pack' ? units : null,
    size: buyMode === 'bottle' || buyMode === 'bag' ? units : null,
    packageLabel: buyMode === 'single' ? '' : pkg || DEFAULT_PACKAGE_LABEL[buyMode],
    unitLabel: buyMode === 'single' ? unit || pkg || 'unidade' : buyMode === 'pack' ? unit || 'unidade' : '',
  };
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Rascunho → formato do cadastro (measure, packageQty em milli e rótulos). */
export function packagingFromDraft(d: PackDraft): Checked<Packaging> {
  const unitLabel = d.unitLabel.trim();
  const packageLabel = d.packageLabel.trim();
  switch (d.buyMode) {
    case 'single': {
      const label = unitLabel || 'unidade';
      return { ok: true, value: { measure: 'unit', packageQty: MILLI, packageLabel: label, unitLabel: label } };
    }
    case 'pack': {
      if (!d.perPack || d.perPack < 2 || Math.round(d.perPack * MILLI) <= MILLI) {
        return { ok: false, error: `Informe quantas unidades vêm em cada ${packageLabel || 'embalagem'} (2 ou mais). Se vem uma só, escolha “Unidade avulsa”.` };
      }
      return { ok: true, value: { measure: 'unit', packageQty: Math.round(d.perPack * MILLI), packageLabel: packageLabel || 'fardo', unitLabel: unitLabel || 'unidade' } };
    }
    case 'bottle':
    case 'bag': {
      const what = d.buyMode === 'bottle' ? 'o tamanho da garrafa em ml' : 'o peso do pacote em gramas';
      if (!d.size || d.size <= 0 || Math.round(d.size * MILLI) <= 0) return { ok: false, error: `Informe ${what}.` };
      return {
        ok: true,
        value: { measure: BUY_MEASURE[d.buyMode], packageQty: Math.round(d.size * MILLI), packageLabel: packageLabel || DEFAULT_PACKAGE_LABEL[d.buyMode], unitLabel: null },
      };
    }
  }
}

/** Embalagem usada só para exibir prévias enquanto o formulário está incompleto. */
export function previewPackaging(d: PackDraft): Packaging {
  const r = packagingFromDraft(d);
  if (r.ok) return r.value;
  const base = PACK_DEFAULTS[d.buyMode];
  const fallback = packagingFromDraft({ ...base, packageLabel: d.packageLabel || base.packageLabel, unitLabel: d.unitLabel || base.unitLabel });
  return fallback.ok ? fallback.value : { measure: BUY_MEASURE[d.buyMode], packageQty: MILLI };
}

// ------------------------------------------------------------------ venda

export interface SellDraft {
  mode: SellMode;
  /** Dose em ml (garrafa) ou porção em g (pacote). */
  dose: number | null;
  priceCents: number | null;
  /** Vendendo por dose, também vende a garrafa (ou o pacote) fechada por este preço. */
  wholePriceCents?: number | null;
}

export const SELL_DEFAULT: Record<BuyMode, SellMode> = { single: 'unit', pack: 'unit', bottle: 'dose', bag: 'ingredient' };
export const DOSE_DEFAULT: Record<BuyMode, number | null> = { single: null, pack: null, bottle: 50, bag: 100 };

export function defaultSell(buy: BuyMode): SellDraft {
  return { mode: SELL_DEFAULT[buy], dose: DOSE_DEFAULT[buy], priceCents: null };
}

export function sellModesFor(buy: BuyMode): SellMode[] {
  return buy === 'single' || buy === 'pack' ? ['unit', 'ingredient'] : ['dose', 'unit', 'ingredient'];
}

/** Rótulo do campo de preço conforme o jeito de vender. */
export function priceLabel(sell: SellMode, p: Packaging): string {
  if (sell === 'dose') return p.measure === 'mass' ? 'Preço da porção' : 'Preço da dose';
  if (buyModeOf(p) === 'single' || buyModeOf(p) === 'pack') return `Preço de 1 ${unitName(p, 1)}`;
  return `Preço de 1 ${packName(p, 1)}`;
}

export interface PresentationInput {
  name: string;
  priceCents: number;
  components: { productId: null; qty: number }[];
}

/** Apresentação de venda criada pelo cadastro rápido (vazia para ingredientes). */
export function presentationsFor(sell: SellDraft, p: Packaging): Checked<PresentationInput[]> {
  if (sell.mode === 'ingredient') return { ok: true, value: [] };
  if (sell.priceCents === null || sell.priceCents < 0) return { ok: false, error: 'Informe o preço de venda.' };
  if (sell.mode === 'dose') {
    const dose = Math.round((sell.dose ?? 0) * MILLI);
    const what = p.measure === 'mass' ? 'porção' : 'dose';
    if (dose <= 0) return { ok: false, error: `Informe o tamanho da ${what}.` };
    if (dose > p.packageQty) return { ok: false, error: `A ${what} não pode ser maior que ${p.measure === 'mass' ? 'o pacote' : 'a garrafa'}.` };
    const unit = p.measure === 'mass' ? 'g' : 'ml';
    const value: PresentationInput[] = [{ name: `${p.measure === 'mass' ? 'Porção' : 'Dose'} ${sell.dose} ${unit}`, priceCents: sell.priceCents, components: [{ productId: null, qty: dose }] }];
    // A mesma garrafa: a dose baixa os ml e a garrafa fechada baixa a garrafa inteira.
    if (sell.wholePriceCents && sell.wholePriceCents > 0) {
      value.push({ name: `${cap(packName(p, 1))} fechad${isFemininePt(packName(p, 1)) ? 'a' : 'o'}`, priceCents: sell.wholePriceCents, components: [{ productId: null, qty: p.packageQty }] });
    }
    return { ok: true, value };
  }
  const single = buyModeOf(p) === 'single' || buyModeOf(p) === 'pack';
  return {
    ok: true,
    value: [{ name: single ? 'Unidade' : cap(packName(p, 1)), priceCents: sell.priceCents, components: [{ productId: null, qty: single ? MILLI : p.packageQty }] }],
  };
}

// ------------------------------------------------------- quantidade e custo

export interface QtyDraft {
  amount: number | null;
  mode: QtyMode;
}

export interface CostDraft {
  cents: number | null;
  mode: CostMode;
}

export const defaultQtyMode = (p: Packaging): QtyMode => (buyModeOf(p) === 'single' ? 'unit' : 'pack');
export const emptyQty = (p: Packaging): QtyDraft => ({ amount: null, mode: defaultQtyMode(p) });
export const defaultCostMode = (p: Packaging): CostMode => (buyModeOf(p) === 'single' ? 'unit' : 'pack');

/** Rascunho → milli (0 quando vazio). */
export function qtyOf(d: QtyDraft, p: Packaging): number {
  return d.amount === null ? 0 : qtyFrom(d.amount, buyModeOf(p) === 'single' ? 'unit' : d.mode, p);
}

/** Quantidade gravada → rascunho no modo mais natural (ex.: mínimo de 24 latas = 2 fardos). */
export function qtyDraftFrom(qty: number, p: Packaging): QtyDraft {
  const mode = preferredMode(qty, p);
  return { amount: qty === 0 ? null : amountIn(qty, mode, p), mode };
}

/** Rótulo do botão de modo: "Fardos" / "Latas" / "Garrafas" / "ml" / "L" / "kg". */
export function modeLabel(mode: QtyMode, p: Packaging): string {
  if (mode === 'pack') return cap(packName(p, 2));
  if (mode === 'kilo') return bigUnitName(p.measure) ?? unitName(p, 2);
  return p.measure === 'unit' ? cap(unitName(p, 2)) : unitName(p, 2);
}

/** Modos do campo de quantidade: embalagem e unidade solta; ml e g também em L e kg (5 kg = 5.000 g). */
export function qtyModes(p: Packaging): QtyMode[] {
  if (buyModeOf(p) === 'single') return ['unit'];
  return p.measure === 'unit' ? ['pack', 'unit'] : ['pack', 'unit', 'kilo'];
}

export function costModes(p: Packaging): { value: CostMode; label: string }[] {
  const buy = buyModeOf(p);
  const total = { value: 'total' as const, label: 'Total' };
  if (buy === 'single') return [{ value: 'unit', label: `Por ${unitName(p, 1)}` }, total];
  if (buy === 'pack') return [{ value: 'pack', label: `Por ${packName(p, 1)}` }, { value: 'unit', label: `Por ${unitName(p, 1)}` }, total];
  // "Por kg"/"Por L" só quando difere da embalagem (pacote de 2,5 kg; na garrafa de 1 L seria repetido).
  if (p.packageQty === KILO) return [{ value: 'pack', label: `Por ${packName(p, 1)}` }, total];
  return [{ value: 'pack', label: `Por ${packName(p, 1)}` }, { value: 'kilo', label: `Por ${bigUnitName(p.measure)}` }, total];
}

/** Campos da compra enviados à API: embalagens quando digitou em embalagens, senão a quantidade solta. */
export function entryPayload(d: QtyDraft, p: Packaging): { packages: number } | { qty: number } {
  if (buyModeOf(p) !== 'single' && d.mode === 'pack') return { packages: d.amount ?? 0 };
  return { qty: qtyOf(d, p) };
}
