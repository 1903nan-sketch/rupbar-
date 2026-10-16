import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db';
import { migrate, MIGRATIONS } from '../src/db/migrations';
import { allocateProductCode, backfillProductCodes } from '../src/db/product-codes';
import { category, createEnv, setupEstablishment, uuid, type Client, type TestEnv } from './helpers';

let env: TestEnv | null = null;
afterEach(async () => {
  if (env) { await env.app.close(); env.s.close(); env = null; }
});

async function owner(): Promise<Client> {
  env = await createEnv();
  return setupEstablishment(env);
}

const unitProduct = async (c: Client, name: string, extra: Record<string, unknown> = {}) =>
  c.ok('POST', '/api/products', { name, categoryId: await category(c, 'Cervejas'), measure: 'unit', ...extra });

describe('código interno automático', () => {
  it('gera 0001, 0002… para produtos sem código e devolve o código no cadastro', async () => {
    const c = await owner();
    const a = await unitProduct(c, 'Cerveja A');
    const b = await unitProduct(c, 'Cerveja B');
    const d = await unitProduct(c, 'Cerveja C', { internalCode: '   ' });
    expect([a.internalCode, b.internalCode, d.internalCode]).toEqual(['0001', '0002', '0003']);
    expect((await c.ok('GET', `/api/products/${a.id}`)).internalCode).toBe('0001');
    const codes = env!.s.db.all<{ internal_code: string }>('SELECT internal_code FROM products ORDER BY internal_code').map((r) => r.internal_code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('pula códigos já usados (inclusive "3" equivalente a 0003) e mostra a prévia sem reservar', async () => {
    const c = await owner();
    await unitProduct(c, 'Manual dois', { internalCode: '0002' });
    await unitProduct(c, 'Manual três', { internalCode: '3' });
    await unitProduct(c, 'Manual texto', { internalCode: 'CERV-01' });
    expect(await c.ok('GET', '/api/products/next-code')).toEqual({ code: '0001' });
    expect(await c.ok('GET', '/api/products/next-code')).toEqual({ code: '0001' });
    expect((await unitProduct(c, 'Auto 1')).internalCode).toBe('0001');
    expect((await unitProduct(c, 'Auto 2')).internalCode).toBe('0004');
    expect((await unitProduct(c, 'Auto 3')).internalCode).toBe('0005');
    expect(await c.ok('GET', '/api/products/next-code')).toEqual({ code: '0006' });
  });

  it('recusa código repetido ou equivalente e não consome a sequência quando o cadastro falha', async () => {
    const c = await owner();
    const first = await unitProduct(c, 'Primeiro');
    expect(first.internalCode).toBe('0001');
    const cat = await category(c, 'Cervejas');
    expect((await c.fail('POST', '/api/products', { name: 'Duplicado', categoryId: cat, measure: 'unit', internalCode: '0001' })).code).toBe('DUPLICATE_CODE');
    expect((await c.fail('POST', '/api/products', { name: 'Equivalente', categoryId: cat, measure: 'unit', internalCode: '1' })).code).toBe('DUPLICATE_CODE');
    // Falha depois da reserva (fornecedor inexistente): a transação desfaz também a sequência.
    expect((await c.fail('POST', '/api/products', { name: 'Falha', categoryId: cat, measure: 'unit', initialStock: { packages: 1, totalCostCents: 100 }, supplierId: uuid() })).status).toBeGreaterThanOrEqual(400);
    expect((await unitProduct(c, 'Segundo')).internalCode).toBe('0002');
  });

  it('na edição mantém o código atual, permite trocar e só gera quando o produto não tem nenhum', async () => {
    const c = await owner();
    const cat = await category(c, 'Cervejas');
    const base = { name: 'Editável', categoryId: cat, measure: 'unit' };
    const p = await c.ok('POST', '/api/products', base);
    expect(p.internalCode).toBe('0001');
    expect((await c.ok('PUT', `/api/products/${p.id}`, { ...base, internalCode: null })).internalCode).toBe('0001');
    expect((await c.ok('PUT', `/api/products/${p.id}`, { ...base, name: 'Editável 2' })).internalCode).toBe('0001');
    expect((await c.ok('PUT', `/api/products/${p.id}`, { ...base, internalCode: 'BAR-7' })).internalCode).toBe('BAR-7');
    expect((await c.ok('GET', `/api/products/${p.id}`)).internalCode).toBe('BAR-7');
    // Editar não gasta números da sequência.
    expect((await unitProduct(c, 'Novo')).internalCode).toBe('0002');
    // Produto antigo sem código (cadastro anterior à numeração) ganha um ao ser salvo.
    env!.s.db.run('UPDATE products SET internal_code = NULL WHERE id = ?', p.id);
    expect((await c.ok('PUT', `/api/products/${p.id}`, base)).internalCode).toBe('0003');
    // Um produto pode manter o próprio código numérico ao ser salvo.
    expect((await c.ok('PUT', `/api/products/${p.id}`, { ...base, internalCode: '0003' })).internalCode).toBe('0003');
  });

  it('busca pelo código com ou sem zeros à esquerda', async () => {
    const c = await owner();
    for (let i = 1; i <= 7; i++) await unitProduct(c, `Produto ${i}`);
    expect((await c.ok('GET', '/api/products?q=7')).map((p: { name: string }) => p.name)).toEqual(['Produto 7']);
    expect((await c.ok('GET', `/api/products?q=${encodeURIComponent('#0007')}`)).map((p: { name: string }) => p.name)).toEqual(['Produto 7']);
    expect((await c.ok('GET', '/api/products?q=0003')).map((p: { name: string }) => p.name)).toEqual(['Produto 3']);
  });

  it('preenche códigos de produtos antigos na ordem de cadastro', async () => {
    const c = await owner();
    for (const name of ['Antigo 1', 'Antigo 2', 'Antigo 3']) await unitProduct(c, name);
    const db = env!.s.db;
    db.run("UPDATE products SET internal_code = NULL WHERE name IN ('Antigo 1', 'Antigo 3')");
    db.run("UPDATE products SET internal_code = '1' WHERE name = 'Antigo 2'");
    db.run("DELETE FROM sequences WHERE name = 'product_code'");
    expect(db.tx(() => backfillProductCodes(db, '2026-03-14T22:00:00.000Z'))).toBe(2);
    const byName = Object.fromEntries(db.all<{ name: string; internal_code: string }>('SELECT name, internal_code FROM products').map((r) => [r.name, r.internal_code]));
    expect(byName).toEqual({ 'Antigo 1': '0002', 'Antigo 2': '1', 'Antigo 3': '0003' });
    expect(db.tx(() => allocateProductCode(db))).toBe('0004');
    expect(db.tx(() => backfillProductCodes(db, '2026-03-14T22:00:00.000Z'))).toBe(0);
  });
});

describe('migração de código automático', () => {
  it('adiciona a unidade avulsa e numera os produtos existentes ao atualizar o banco', () => {
    const db = new Db(':memory:');
    try {
      const target = MIGRATIONS.find((m) => m.name.startsWith('código automático'))!;
      // Banco "antigo": todas as migrações anteriores aplicadas.
      db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const m of MIGRATIONS.filter((x) => x.id < target.id)) {
        db.exec(m.sql);
        m.run?.(db);
        db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)', m.id, m.name, '2026-01-01T00:00:00Z');
      }
      db.run("INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1', 'Bebidas', 'x', 'x')");
      const insert = (id: string, code: string | null, at: string) =>
        db.run("INSERT INTO products (id, name, category_id, internal_code, measure, created_at, updated_at) VALUES (?, ?, 'c1', ?, 'unit', ?, ?)", id, `P ${id}`, code, at, at);
      insert('b', null, '2026-01-02');
      insert('a', null, '2026-01-01');
      insert('c', '0001', '2026-01-03');
      insert('d', 'X-9', '2026-01-04');
      expect(migrate(db).applied).toEqual(MIGRATIONS.filter((x) => x.id >= target.id).map((x) => x.id));
      const codes = Object.fromEntries(db.all<{ id: string; internal_code: string; version: number }>('SELECT id, internal_code FROM products').map((r) => [r.id, r.internal_code]));
      expect(codes).toEqual({ a: '0002', b: '0003', c: '0001', d: 'X-9' });
      expect(db.value('SELECT version FROM products WHERE id = ?', 'a')).toBe(2);
      expect(db.value("SELECT value FROM sequences WHERE name = 'product_code'")).toBe(3);
      expect(db.all("SELECT name FROM pragma_table_info('products') WHERE name = 'unit_label'")).toHaveLength(1);
      expect(migrate(db).applied).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('entrada em embalagens ou em unidades soltas', () => {
  const fardo = (cat: string) => ({
    name: 'Cerveja lata', categoryId: cat, measure: 'unit', packageQty: 12_000, packageLabel: 'fardo', unitLabel: 'lata',
    presentations: [{ name: 'Unidade', priceCents: 900, components: [{ productId: null, qty: 1000 }] }],
  });

  it('registra fardos ou latas soltas com o mesmo custo por lata', async () => {
    const c = await owner();
    const p = await c.ok('POST', '/api/products', { ...fardo(await category(c, 'Cervejas')), initialStock: { packages: 2, totalCostCents: 8400 } });
    let saved = await c.ok('GET', `/api/products/${p.id}`);
    expect(saved).toMatchObject({ stockQty: 24_000, unitCostE4: 3_500_000, unitLabel: 'lata', packageLabel: 'fardo', doseQty: 1000 });
    // 30 latas soltas, R$ 105,00 → R$ 3,50 por lata (2,5 fardos registrados na compra).
    await c.ok('POST', '/api/stock/purchases', { items: [{ productId: p.id, qty: 30_000, totalCostCents: 10_500 }] });
    saved = await c.ok('GET', `/api/products/${p.id}`);
    expect(saved).toMatchObject({ stockQty: 54_000, unitCostE4: 3_500_000, packages: { closed: 4, openRemaining: 6_000 } });
    const item = env!.s.db.get<{ packages_milli: number; package_qty: number; qty: number }>('SELECT packages_milli, package_qty, qty FROM purchase_items WHERE qty = 30000');
    expect(item).toEqual({ packages_milli: 2500, package_qty: 12_000, qty: 30_000 });
    // Sem packageQty, a compra usa o tamanho do cadastro.
    await c.ok('POST', '/api/stock/purchases', { items: [{ productId: p.id, packages: 1, totalCostCents: 4200 }] });
    expect((await c.ok('GET', `/api/products/${p.id}`)).stockQty).toBe(66_000);
    // Fardo diferente nesta compra (15 latas).
    await c.ok('POST', '/api/stock/purchases', { items: [{ productId: p.id, packages: 2, packageQty: 15_000, totalCostCents: 10_500 }] });
    expect((await c.ok('GET', `/api/products/${p.id}`)).stockQty).toBe(96_000);
  });

  it('cadastra saldo inicial direto em unidades e recusa quantidade ambígua ou vazia', async () => {
    const c = await owner();
    const cat = await category(c, 'Cervejas');
    const p = await c.ok('POST', '/api/products', { ...fardo(cat), initialStock: { qty: 7_000, totalCostCents: 2450 } });
    expect(await c.ok('GET', `/api/products/${p.id}`)).toMatchObject({ stockQty: 7_000, unitCostE4: 3_500_000 });
    expect((await c.fail('POST', '/api/products', { ...fardo(cat), name: 'Ambíguo', initialStock: { qty: 1000, packages: 1, totalCostCents: 1 } })).status).toBe(400);
    expect((await c.fail('POST', '/api/products', { ...fardo(cat), name: 'Vazio', initialStock: { totalCostCents: 1 } })).status).toBe(400);
    expect((await c.fail('POST', '/api/stock/purchases', { items: [{ productId: p.id, totalCostCents: 100 }] })).status).toBe(400);
    expect((await c.fail('POST', '/api/stock/purchases', { items: [{ productId: p.id, qty: 1000, packages: 1, totalCostCents: 100 }] })).status).toBe(400);
    expect((await c.fail('POST', '/api/stock/purchases', { items: [{ productId: p.id, packages: 0.0000001, totalCostCents: 100 }] })).code).toBe('INVALID_QTY');
    expect((await c.ok('GET', `/api/products/${p.id}`)).stockQty).toBe(7_000);
  });

  it('lança garrafas em ml e informa a dose para a conversão', async () => {
    const c = await owner();
    const whisky = await c.ok('POST', '/api/products', {
      name: 'Whisky', categoryId: await category(c, 'Destilados'), measure: 'volume', packageQty: 1_000_000, packageLabel: 'garrafa',
      presentations: [
        { name: 'Dose 50 ml', priceCents: 2990, components: [{ productId: null, qty: 50_000 }] },
        { name: 'Dose dupla', priceCents: 5500, components: [{ productId: null, qty: 100_000 }] },
      ],
    });
    await c.ok('POST', '/api/stock/purchases', { items: [{ productId: whisky.id, qty: 2_500_000, totalCostCents: 37_500 }] });
    const saved = await c.ok('GET', `/api/products/${whisky.id}`);
    expect(saved).toMatchObject({ stockQty: 2_500_000, unitCostE4: 150_000, doseQty: 50_000, unitLabel: null });
    expect(env!.s.db.value('SELECT packages_milli FROM purchase_items')).toBe(2500);
    const purchases = await c.ok('GET', '/api/stock/purchases');
    expect(purchases[0].items[0]).toMatchObject({ package_label: 'garrafa', unit_label: null, qty: 2_500_000 });
  });
});
