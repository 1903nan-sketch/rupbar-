import { describe, expect, it } from 'vitest';
import {
  comandaDisplayNumber, comandaLabel, displayName,
  applyBasisPoints, billTotals, cashClosing, changeFor, consumptionFor, costOf, countedFromPackages, divergence,
  effectivePermissions, formatBRL, formatQty, hookahCharge, initials, isStale, isValidCnpj, isValidCpf, isUuid,
  maskCpf, maskPhone, normalizePhoneBR, numberToWordsPtBR, packageBreakdown, parseBRL, parseQty, pickupAnnouncement,
  restockSuggestion, sanitizeGrantable, splitEqually, splitMix, stockLevel, theoreticalYield, toMilli,
  unitCostFromPurchase, uuidv7, uuidv7Time, weightedAverageCost, backoffMs, checkPasswordStrength, SYSTEM_ROLES,
  canTransition, presentationSuffix,
} from '../src';

describe('dinheiro', () => {
  it('formata e interpreta reais', () => {
    expect(formatBRL(12345)).toBe('R$ 123,45');
    expect(parseBRL('R$ 1.234,56')).toBe(123456);
    expect(parseBRL('12,5')).toBe(1250);
    expect(parseBRL('12.50')).toBe(1250);
    expect(parseBRL('1.234')).toBe(123400);
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL('1,234')).toBeNull();
  });
  it('divide sem perder centavos', () => {
    expect(splitEqually(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEqually(1000, 3).reduce((a, b) => a + b)).toBe(1000);
  });
  it('aplica percentual com arredondamento bancário', () => {
    expect(applyBasisPoints(1005, 1000)).toBe(100); // 100.5 -> 100 (par)
    expect(applyBasisPoints(1015, 1000)).toBe(102); // 101.5 -> 102 (par)
  });
});

describe('unidades e estoque por volume', () => {
  it('usa unidades inteiras em milésimos', () => {
    expect(toMilli(1, 'l')).toBe(1_000_000);
    expect(toMilli(30, 'ml')).toBe(30_000);
    expect(toMilli(0.5, 'g')).toBe(500);
    expect(parseQty('1,5', 'l')).toBe(1_500_000);
    expect(formatQty(1_500_000, 'volume')).toBe('1,5 L');
    expect(formatQty(30_000, 'volume')).toBe('30 ml');
    expect(formatQty(12_500, 'mass')).toBe('12,5 g');
  });
  it('vender 50 ml desconta exatamente 50 ml da garrafa de 1 L', () => {
    const bottle = toMilli(1, 'l');
    const after = bottle - consumptionFor([{ productId: 'whisky', qty: toMilli(50, 'ml') }], 1).get('whisky')!;
    expect(after).toBe(950_000);
    // 3 doses de 30 ml + 1 dupla de 100 ml do mesmo estoque
    const c1 = consumptionFor([{ productId: 'whisky', qty: 30_000 }], 3).get('whisky')!;
    const c2 = consumptionFor([{ productId: 'whisky', qty: 100_000 }], 1).get('whisky')!;
    expect(after - c1 - c2).toBe(760_000);
  });
  it('custo por dose sem erro de arredondamento acumulado', () => {
    const cost = unitCostFromPurchase(12_000, toMilli(1, 'l')); // R$120 / 1 L
    expect(cost).toBe(120_000); // 12 centavos/ml × 10⁴
    expect(costOf(toMilli(50, 'ml'), cost)).toBe(600);
    expect(costOf(toMilli(30, 'ml'), cost)).toBe(360);
    // 1000 doses de 1 ml somam exatamente o custo da garrafa
    let total = 0;
    for (let i = 0; i < 1000; i++) total += costOf(1000, cost);
    expect(total).toBe(12_000);
  });
  it('custo médio ponderado', () => {
    expect(weightedAverageCost(1_000_000, 120_000, 1_000_000, 140_000)).toBe(130_000);
    expect(weightedAverageCost(-50_000, 120_000, 1_000_000, 140_000)).toBe(140_000);
  });
  it('garrafas abertas/fechadas, rendimento e divergência', () => {
    expect(packageBreakdown(2_350_000, 1_000_000)).toEqual({ closed: 2, openRemaining: 350_000, hasOpen: true });
    expect(theoreticalYield(1_000_000, 30_000)).toBe(33);
    expect(countedFromPackages(2, 300_000, 1_000_000)).toBe(2_300_000);
    expect(divergence(2_350_000, 2_300_000).diff).toBe(-50_000);
    expect(stockLevel(5_000, 10_000)).toBe('low');
    expect(stockLevel(0, 10_000)).toBe('out');
    expect(restockSuggestion(500_000, 2_000_000, 1_000_000)).toEqual({ qty: 4_000_000, packages: 4 });
  });
  it('ficha técnica agrega ingredientes', () => {
    const burger = [
      { productId: 'pao', qty: 1000 },
      { productId: 'carne', qty: 1000 },
      { productId: 'queijo', qty: 2000 },
    ];
    const c = consumptionFor(burger, 2);
    expect(c.get('queijo')).toBe(4000);
    expect(c.get('pao')).toBe(2000);
  });
});

describe('validações e LGPD', () => {
  it('CPF/CNPJ', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
  });
  it('telefone e máscaras', () => {
    expect(normalizePhoneBR('+55 (11) 98765-4321')).toBe('11987654321');
    expect(normalizePhoneBR('(11) 3333-4444')).toBe('1133334444');
    expect(normalizePhoneBR('11 8765-43210')).toBeNull();
    expect(maskPhone('11987654321')).toBe('(11) *****-4321');
    expect(maskCpf('52998224725')).toBe('***.982.247-**');
    expect(initials('Bar do Zé')).toBe('BZ');
    expect(initials('Adega')).toBe('AD');
  });
  it('política de senha', () => {
    expect(checkPasswordStrength('abc').ok).toBe(false);
    expect(checkPasswordStrength('carlos2024x', ['carlos@bar.com']).ok).toBe(false);
    expect(checkPasswordStrength('Lua-de-Prata-77').ok).toBe(true);
  });
});

describe('permissões', () => {
  it('proprietário tem tudo; perdas e contas são exclusivas', () => {
    const owner = effectivePermissions({ roleKey: 'owner', rolePermissions: [] });
    expect(owner.has('losses.confirm')).toBe(true);
    const manager = effectivePermissions({ roleKey: 'manager', rolePermissions: SYSTEM_ROLES.manager.permissions, grants: ['losses.confirm', 'users.manage'] });
    expect(manager.has('losses.confirm')).toBe(false);
    expect(manager.has('users.manage')).toBe(false);
    expect(manager.has('reports.financial')).toBe(false);
  });
  it('funcionários comuns não acessam relatórios financeiros', () => {
    for (const key of ['cashier', 'waiter', 'kitchen', 'manager'] as const) {
      expect(SYSTEM_ROLES[key].permissions).not.toContain('reports.financial');
    }
  });
  it('remove permissões inválidas e exclusivas', () => {
    expect(sanitizeGrantable(['cash.open', 'users.manage', 'xpto', 'cash.open'])).toEqual(['cash.open']);
  });
  it('negações individuais', () => {
    const w = effectivePermissions({ roleKey: 'waiter', rolePermissions: SYSTEM_ROLES.waiter.permissions, denies: ['hookah.rent'] });
    expect(w.has('hookah.rent')).toBe(false);
    expect(w.has('orders.create')).toBe(true);
  });
});

describe('caixa e conta', () => {
  it('fechamento com sangria, suprimento e diferença', () => {
    const s = cashClosing({
      openingBalance: 10_000,
      payments: [
        { method: 'cash', amount: 5_000 },
        { method: 'pix', amount: 7_000 },
        { method: 'cash', amount: 2_500 },
      ],
      withdrawals: [3_000],
      supplies: [1_000],
      countedCash: 15_300,
    });
    expect(s.expectedCash).toBe(15_500);
    expect(s.difference).toBe(-200);
    expect(s.byMethod).toEqual({ cash: 7_500, pix: 7_000 });
    expect(s.totalSales).toBe(14_500);
  });
  it('totais da conta com desconto e taxa de serviço', () => {
    const t = billTotals(
      [{ quantity: 2, unitPrice: 1_000 }, { quantity: 1, unitPrice: 500, canceled: true }, { quantity: 1, unitPrice: 2_000 }],
      { discount: 500, serviceFeeBp: 1000, paid: 1_000 },
    );
    expect(t).toEqual({ subtotal: 4_000, discount: 500, serviceFee: 350, total: 3_850, paid: 1_000, remaining: 2_850 });
    expect(changeFor(3_850, 5_000)).toBe(1_150);
  });
});

describe('narguilé', () => {
  const t0 = Date.parse('2026-01-01T20:00:00Z');
  it('valor fixo', () => {
    expect(hookahCharge({ mode: 'fixed', priceCents: 4_000 }, t0, t0 + 200 * 60_000).totalCents).toBe(4_000);
  });
  it('por período com tolerância', () => {
    const p = { mode: 'per_period' as const, priceCents: 3_000, periodMinutes: 60, toleranceMinutes: 10 };
    expect(hookahCharge(p, t0, t0 + 30 * 60_000).periods).toBe(1);
    expect(hookahCharge(p, t0, t0 + 69 * 60_000).periods).toBe(1);
    expect(hookahCharge(p, t0, t0 + 71 * 60_000).periods).toBe(2);
    expect(hookahCharge(p, t0, t0 + 131 * 60_000).totalCents).toBe(9_000);
  });
  it('mistura de essências por proporção sem perder gramas', () => {
    const s = splitMix(12_000, [{ productId: 'menta', ratio: 2 }, { productId: 'uva', ratio: 1 }]);
    expect(s).toEqual([{ productId: 'menta', qty: 8_000 }, { productId: 'uva', qty: 4_000 }]);
    const odd = splitMix(10_001, [{ productId: 'a', ratio: 1 }, { productId: 'b', ratio: 1 }, { productId: 'c', ratio: 1 }]);
    expect(odd.reduce((a, x) => a + x.qty, 0)).toBe(10_001);
  });
});

describe('voz da TV', () => {
  it('números por extenso', () => {
    expect(numberToWordsPtBR(42)).toBe('quarenta e dois');
    expect(numberToWordsPtBR(100)).toBe('cem');
    expect(numberToWordsPtBR(101)).toBe('cento e um');
    expect(numberToWordsPtBR(115)).toBe('cento e quinze');
    expect(numberToWordsPtBR(1000)).toBe('mil');
    expect(numberToWordsPtBR(1020)).toBe('mil e vinte');
    expect(numberToWordsPtBR(1234)).toBe('mil duzentos e trinta e quatro');
    expect(numberToWordsPtBR(2500)).toBe('dois mil e quinhentos');
  });
  it('anúncio', () => {
    expect(pickupAnnouncement(42, 'Carlos')).toBe('Carlos, seu pedido está pronto. Retirar no balcão.');
    expect(pickupAnnouncement(42, 'Carlos', 'no balcão', 23)).toBe('Carlos, comanda vinte e três. Seu pedido está pronto, retirar no balcão.');
    expect(pickupAnnouncement(9, null, 'no balcão', 5)).toBe('Comanda cinco, seu pedido está pronto. Retirar no balcão.');
    expect(pickupAnnouncement(7, null)).toBe('Pedido número sete. Retirar no balcão.');
  });
});

describe('identificadores e sincronização', () => {
  it('uuid v7 ordenável e único', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7(1_700_000_000_000));
    expect(new Set(ids).size).toBe(2000);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every(isUuid)).toBe(true);
    expect(uuidv7Time(uuidv7(1_800_000_000_000))).toBe(1_800_000_000_000);
  });
  it('backoff cresce e respeita o teto', () => {
    expect(backoffMs(1, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffMs(3, 1000, 60_000, () => 1)).toBe(4000);
    expect(backoffMs(20, 1000, 60_000, () => 1)).toBe(60_000);
  });
  it('dados desatualizados', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(isStale('2026-01-01T11:50:00Z', now)).toBe(false);
    expect(isStale('2026-01-01T11:00:00Z', now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
  });
  it('transições do painel de produção', () => {
    expect(canTransition('received', 'preparing')).toBe(true);
    expect(canTransition('canceled', 'ready')).toBe(false);
  });
});

describe('comandas e nomes de chamada', () => {
  it('mostra o número do cartão quando houver', () => {
    expect(comandaLabel({ number: 105, cardNumber: 23 })).toBe('Comanda 23');
    expect(comandaLabel({ number: 105, cardNumber: null })).toBe('Comanda 105');
    expect(comandaLabel({ number: 106, kind: 'quick' })).toBe('Venda rápida 106');
    expect(comandaDisplayNumber({ number: 106, kind: 'quick' })).toBeNull();
    expect(comandaDisplayNumber({ number: 105, cardNumber: 7, kind: 'regular' })).toBe(7);
  });
  it('nome de chamada com inicial do sobrenome', () => {
    expect(displayName('Carlos Alberto Silva')).toBe('Carlos S.');
    expect(displayName('ana')).toBe('ana');
    expect(displayName('Maria da')).toBe('Maria');
    expect(displayName('  ')).toBe('');
  });
});

describe('nome da apresentação junto do produto', () => {
  it('não repete "Unidade" nem o próprio nome do produto', () => {
    expect(presentationSuffix('Heineken long neck', 'Unidade')).toBeNull();
    expect(presentationSuffix('Heineken long neck', ' heineken LONG neck ')).toBeNull();
    expect(presentationSuffix('Gin Rocks 1 L', 'Dose 50 ml')).toBe('Dose 50 ml');
  });
});
