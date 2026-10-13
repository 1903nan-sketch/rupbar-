import { describe, expect, it } from 'vitest';
import {
  amountIn, buyModeOf, countQty, costPer, describeEntry, describePack, describeStock, entryQtyMilli, entrySuggestion,
  formatProductCode, isFemininePt, matchesProductCode, nextProductCode, packBreakdownText, packName, pluralPt,
  preferredMode, productCodeKey, qtyFrom, stockText, totalCostFrom, unitName, type Packaging,
} from '../src';

const fardo: Packaging = { measure: 'unit', packageQty: 12_000, packageLabel: 'fardo', unitLabel: 'lata' };
const avulsa: Packaging = { measure: 'unit', packageQty: 1_000, packageLabel: 'long neck', unitLabel: null };
const garrafa: Packaging = { measure: 'volume', packageQty: 1_000_000, packageLabel: 'garrafa' };
const essencia: Packaging = { measure: 'mass', packageQty: 50_000, packageLabel: null };

describe('nomes de embalagem e unidade', () => {
  it('flexiona rótulos comuns do bar', () => {
    expect(pluralPt('lata')).toBe('latas');
    expect(pluralPt('fardo')).toBe('fardos');
    expect(pluralPt('barril')).toBe('barris');
    expect(pluralPt('galão')).toBe('galões');
    expect(pluralPt('pão')).toBe('pães');
    expect(pluralPt('garrafa long neck')).toBe('garrafas long neck');
    expect(pluralPt('long neck')).toBe('long necks');
    expect(pluralPt('caixa de 12')).toBe('caixas de 12');
    expect(isFemininePt('garrafa')).toBe(true);
    expect(isFemininePt('unidade')).toBe(true);
    expect(isFemininePt('fardo')).toBe(false);
    expect(isFemininePt('pacote')).toBe(false);
  });

  it('identifica como o produto é comprado', () => {
    expect(buyModeOf(fardo)).toBe('pack');
    expect(buyModeOf(avulsa)).toBe('single');
    expect(buyModeOf(garrafa)).toBe('bottle');
    expect(buyModeOf(essencia)).toBe('bag');
  });

  it('usa nomes padrão quando o cadastro não informa', () => {
    expect(unitName(fardo, 2)).toBe('latas');
    expect(unitName(avulsa, 1)).toBe('long neck');
    expect(unitName({ measure: 'unit', packageQty: 1000 }, 3)).toBe('unidades');
    expect(unitName(garrafa, 3)).toBe('ml');
    expect(packName(essencia, 2)).toBe('pacotes');
    expect(describePack(fardo)).toBe('fardo de 12 latas');
    expect(describePack(garrafa)).toBe('garrafa de 1.000 ml');
    expect(describePack(essencia)).toBe('pacote de 50 g');
    expect(describePack(avulsa)).toBe('long neck');
  });
});

describe('saldo nas duas formas', () => {
  it('mostra latas e fardos', () => {
    expect(describeStock(48_000, fardo)).toEqual({ main: '48 latas', detail: '4 fardos' });
    expect(describeStock(30_000, fardo)).toEqual({ main: '30 latas', detail: '2 fardos + 6 latas' });
    expect(describeStock(6_000, fardo)).toEqual({ main: '6 latas', detail: null });
    expect(describeStock(1_000, fardo)).toEqual({ main: '1 lata', detail: null });
    expect(describeStock(-3_000, fardo)).toEqual({ main: '-3 latas', detail: null });
    expect(stockText(13_000, fardo)).toBe('13 latas (1 fardo + 1 lata)');
  });

  it('mostra garrafas e ml, pacotes e g', () => {
    expect(stockText(2_500_000, garrafa)).toBe('2,5 garrafas (2.500 ml)');
    expect(stockText(1_000_000, garrafa)).toBe('1 garrafa (1.000 ml)');
    expect(stockText(0, garrafa)).toBe('0 garrafas');
    expect(stockText(150_000, essencia)).toBe('3 pacotes (150 g)');
    expect(stockText(7_000, avulsa)).toBe('7 long necks');
  });

  it('decompõe em embalagens fechadas', () => {
    expect(packBreakdownText(25_000, fardo)).toBe('2 fardos + 1 lata');
    expect(packBreakdownText(11_000, fardo)).toBeNull();
    expect(packBreakdownText(2_350_000, garrafa)).toBe('2 garrafas + 350 ml');
  });
});

describe('conversão entre embalagem e unidade solta', () => {
  it('converte o número digitado nos dois modos', () => {
    expect(qtyFrom(2, 'pack', fardo)).toBe(24_000);
    expect(qtyFrom(30, 'unit', fardo)).toBe(30_000);
    expect(qtyFrom(1.5, 'pack', garrafa)).toBe(1_500_000);
    expect(qtyFrom(350, 'unit', garrafa)).toBe(350_000);
    expect(amountIn(24_000, 'pack', fardo)).toBe(2);
    expect(amountIn(24_000, 'unit', fardo)).toBe(24);
    expect(entryQtyMilli({ packages: 2 }, 12_000)).toBe(24_000);
    expect(entryQtyMilli({ qty: 7_000 }, 12_000)).toBe(7_000);
    expect(countQty(3, 5, fardo)).toBe(41_000);
    expect(countQty(2, 350, garrafa)).toBe(2_350_000);
    expect(countQty(9, 4, avulsa)).toBe(4_000);
  });

  it('escolhe o modo natural para valores gravados', () => {
    expect(preferredMode(24_000, fardo)).toBe('pack');
    expect(preferredMode(6_000, fardo)).toBe('unit');
    expect(preferredMode(0, garrafa)).toBe('pack');
    expect(preferredMode(5_000, avulsa)).toBe('unit');
  });

  it('calcula custo total e custo por unidade', () => {
    expect(totalCostFrom(4200, 'pack', 24_000, fardo)).toBe(8400);
    expect(totalCostFrom(350, 'unit', 24_000, fardo)).toBe(8400);
    expect(totalCostFrom(8400, 'total', 24_000, fardo)).toBe(8400);
    expect(totalCostFrom(15_000, 'pack', 500_000, garrafa)).toBe(7500);
    expect(costPer(8400, 24_000, 1_000)).toBe(350);
    expect(costPer(15_000, 1_000_000, 50_000)).toBe(750);
    expect(costPer(100, 0, 1000)).toBeNull();
  });
});

describe('frase de conferência e prevenção de enganos', () => {
  it('descreve a entrada em linguagem simples', () => {
    expect(describeEntry(2, 'pack', fardo)).toEqual({ lead: '2 fardos de 12', equals: ['24 latas'] });
    expect(describeEntry(30, 'unit', fardo)).toEqual({ lead: '30 latas', equals: ['2 fardos + 6 latas'] });
    expect(describeEntry(1, 'pack', garrafa, 50_000)).toEqual({ lead: '1 garrafa de 1.000 ml', equals: ['20 doses de 50 ml'] });
    expect(describeEntry(2, 'pack', garrafa, 50_000)).toEqual({ lead: '2 garrafas de 1.000 ml', equals: ['2.000 ml', '40 doses de 50 ml'] });
    expect(describeEntry(2500, 'unit', garrafa)).toEqual({ lead: '2.500 ml', equals: ['2,5 garrafas de 1.000 ml'] });
    expect(describeEntry(4, 'pack', essencia)).toEqual({ lead: '4 pacotes de 50 g', equals: ['200 g'] });
    expect(describeEntry(6, 'unit', avulsa)).toEqual({ lead: '6 long necks', equals: [] });
  });

  it('pergunta quando o número parece estar no modo errado', () => {
    expect(entrySuggestion(2, 'unit', fardo)).toEqual({ mode: 'pack', qty: 24_000, message: 'Você quis dizer 2 fardos (24 latas)?' });
    expect(entrySuggestion(1, 'unit', fardo)?.message).toBe('Você quis dizer 1 fardo (12 latas)?');
    expect(entrySuggestion(24, 'pack', fardo)).toEqual({ mode: 'unit', qty: 24_000, message: 'Você quis dizer 24 latas (2 fardos)?' });
    expect(entrySuggestion(2, 'unit', garrafa)?.message).toBe('Você quis dizer 2 garrafas (2.000 ml)?');
    expect(entrySuggestion(700, 'pack', garrafa)?.message).toBe('Você quis dizer 700 ml (0,7 garrafa)?');
    // Quantidades plausíveis não geram aviso.
    expect(entrySuggestion(30, 'unit', fardo)).toBeNull();
    expect(entrySuggestion(3, 'pack', fardo)).toBeNull();
    expect(entrySuggestion(350, 'unit', garrafa)).toBeNull();
    expect(entrySuggestion(2.5, 'unit', fardo)).toBeNull();
    expect(entrySuggestion(2, 'unit', avulsa)).toBeNull();
    expect(entrySuggestion(null, 'unit', fardo)).toBeNull();
  });
});

describe('código interno automático', () => {
  it('gera códigos sequenciais com quatro dígitos', () => {
    expect(formatProductCode(7)).toBe('0007');
    expect(formatProductCode(12345)).toBe('12345');
    expect(nextProductCode([], 0)).toEqual({ code: '0001', seq: 1 });
    expect(nextProductCode(['0001', '0002'], 2)).toEqual({ code: '0003', seq: 3 });
  });

  it('pula códigos já usados, inclusive equivalentes sem zeros', () => {
    expect(nextProductCode(['0001', '0002', 'CERV-01'], 0)).toEqual({ code: '0003', seq: 3 });
    expect(nextProductCode(['4', '#0005', null], 3)).toEqual({ code: '0006', seq: 6 });
    expect(productCodeKey('#0007')).toBe('7');
    expect(productCodeKey('0000')).toBe('0');
  });

  it('encontra produtos pelo código digitado de vários jeitos', () => {
    expect(matchesProductCode('0007', '7')).toBe(true);
    expect(matchesProductCode('0007', '#0007')).toBe(true);
    expect(matchesProductCode('0007', '00')).toBe(true);
    expect(matchesProductCode('0007', '8')).toBe(false);
    expect(matchesProductCode('CERV-01', 'cerv')).toBe(true);
    expect(matchesProductCode(null, '7')).toBe(false);
  });
});
