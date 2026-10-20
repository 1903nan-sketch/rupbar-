import { importTemplateCsv } from '@rupbar/core';
import { afterEach, describe, expect, it } from 'vitest';
import { category, createEnv, createStaff, setupEstablishment, type Client, type TestEnv } from './helpers';

let env: TestEnv | null = null;
afterEach(async () => {
  if (env) { await env.app.close(); env.s.close(); env = null; }
});

async function owner(): Promise<Client> {
  env = await createEnv();
  return setupEstablishment(env);
}

const csv = (...rows: string[]) => ['nome;categoria;como_compra;qtd_embalagem;estoque_embalagens;estoque_soltas;custo_embalagem;preco_venda;dose_ml;preco_garrafa;estoque_minimo;codigo_barras', ...rows].join('\r\n');

describe('importar planilha do estoque', () => {
  it('confere sem gravar e depois cria os produtos com saldo, custo, preços e categoria nova', async () => {
    const c = await owner();
    const sheet = csv(
      'Heineken long neck;Cervejas;fardo;24;3;5;120,00;12,00;;;24;7896045506873',
      'Gin Rocks Morango 1 L;Gin;garrafa;1 L;2;500;90,00;12,00;50;120,00;1;',
      'Gelo de coco;;unidade;;;40;1,50;;;;10;',
      'Linha ruim;;barril;;;;;;;;;',
    );
    const preview = await c.ok('POST', '/api/stock/import', { csv: sheet });
    expect(preview).toMatchObject({ committed: false, total: 4, create: 3, update: 0, errors: 1, newCategories: ['Gin'] });
    expect(preview.items[0]).toMatchObject({ line: 2, action: 'create', category: 'Cervejas', newCategory: false, pack: 'fardo de 24 unidades', stock: '77 unidades (3 fardos + 5 unidades)' });
    expect(preview.items[1]).toMatchObject({ action: 'create', category: 'Gin', newCategory: true, stock: '2,5 garrafas (2.500 ml)' });
    expect(preview.items[2]).toMatchObject({ action: 'create', category: 'Outros', presentations: [] });
    expect(preview.items[3]).toMatchObject({ line: 5, action: 'error', error: expect.stringMatching(/unidade, fardo, garrafa ou pacote/) });
    expect(env!.s.db.value('SELECT COUNT(*) FROM products')).toBe(0);

    const done = await c.ok('POST', '/api/stock/import', { csv: sheet, commit: true });
    expect(done).toMatchObject({ committed: true, created: 3, updated: 0, categoriesCreated: ['Gin'] });

    const products = await c.ok<any[]>('GET', '/api/products');
    const beer = products.find((p) => p.name === 'Heineken long neck');
    expect(beer).toMatchObject({ measure: 'unit', packageQty: 24_000, stockQty: 77_000, minStock: 24_000, barcode: '7896045506873', menuVisible: true, unitCostE4: 5_000_000 });
    expect(beer.presentations.map((p: any) => [p.name, p.priceCents])).toEqual([['Unidade', 1200]]);
    const gin = products.find((p) => p.name === 'Gin Rocks Morango 1 L');
    expect(gin).toMatchObject({ measure: 'volume', packageQty: 1_000_000, stockQty: 2_500_000, categoryName: 'Gin', station: 'bar' });
    expect(gin.presentations.map((p: any) => [p.name, p.priceCents, p.components[0].qty])).toEqual([['Dose 50 ml', 1200, 50_000], ['Garrafa fechada', 12_000, 1_000_000]]);
    const ice = products.find((p) => p.name === 'Gelo de coco');
    expect(ice).toMatchObject({ categoryName: 'Outros', stockQty: 40_000, menuVisible: false, presentations: [] });
    // Entrou como entrada de mercadoria com o custo da planilha (3,5 fardos de R$ 120 ≈ 77 latas a R$ 5).
    expect(env!.s.db.value('SELECT SUM(total_cents) FROM purchases')).toBe(38_500 + 22_500 + 6_000);
  });

  it('acha os já cadastrados (código de barras, nome sem acento) e lança a contagem como inventário', async () => {
    const c = await owner();
    const cat = await category(c, 'Águas');
    const water = await c.ok('POST', '/api/products', {
      name: 'Água Mineral 500 ml', categoryId: cat, measure: 'unit', presentations: [{ name: 'Unidade', priceCents: 400 }],
      initialStock: { qty: 10_000, totalCostCents: 1000 },
    });
    const coke = await c.ok('POST', '/api/products', { name: 'Coca-Cola lata', categoryId: await category(c, 'Refrigerantes'), measure: 'unit', barcode: '7894900011517' });
    const sheet = csv(
      'agua mineral 500 ML;;unidade;;24;;1,20;5,00;;;12;',
      'Coca lata (nome diferente);;unidade;;;30;;;;;;7894900011517',
    );
    const preview = await c.ok('POST', '/api/stock/import', { csv: sheet });
    expect(preview.items[0]).toMatchObject({ action: 'update', productId: water.id, matchedBy: 'name', stockBefore: '10 unidades', stock: '24 unidades' });
    expect(preview.items[0].warnings.join(' ')).toMatch(/preços continuam/);
    expect(preview.items[1]).toMatchObject({ action: 'update', productId: coke.id, matchedBy: 'barcode', existingName: 'Coca-Cola lata' });

    const done = await c.ok('POST', '/api/stock/import', { csv: sheet, commit: true });
    expect(done).toMatchObject({ created: 0, updated: 2, divergences: 2 });
    const w = await c.ok('GET', `/api/products/${water.id}`);
    expect(w).toMatchObject({ stockQty: 24_000, minStock: 12_000, unitCostE4: 1_200_000 });
    expect(w.presentations[0].priceCents).toBe(400);
    expect((await c.ok('GET', `/api/products/${coke.id}`)).stockQty).toBe(30_000);
    const inv = await c.ok<any[]>('GET', '/api/stock/inventories');
    expect(inv[0].notes).toBe('Importação de planilha');
  });

  it('recusa linha repetida, tipo diferente do cadastro e planilha sem a coluna nome', async () => {
    const c = await owner();
    await c.ok('POST', '/api/products', { name: 'Gin Rocks', categoryId: await category(c, 'Destilados'), measure: 'volume', packageQty: 1_000_000 });
    const preview = await c.ok('POST', '/api/stock/import', {
      csv: csv('Gin Rocks;;unidade;;3;;;;;;;', 'Red Bull;;unidade;;5;;;;;;;', 'red bull;;unidade;;2;;;;;;;'),
    });
    expect(preview.items.map((i: any) => i.action)).toEqual(['error', 'create', 'error']);
    expect(preview.items[0].error).toMatch(/já está cadastrado como garrafa de 1\.000 ml/);
    expect(preview.items[2].error).toMatch(/Repetido na planilha \(linha 3\)/);
    expect((await c.fail('POST', '/api/stock/import', { csv: 'produto_x;quantidade\nA;1' })).code).toBe('IMPORT_NO_NAME');
    expect((await c.fail('POST', '/api/stock/import', { csv: csv('X;;barril'), commit: true })).code).toBe('IMPORT_EMPTY');
  });

  it('o modelo para baixar importa inteiro e só quem gerencia o estoque pode importar', async () => {
    const c = await owner();
    const waiter = await createStaff(env!, c, 'waiter', 'Rafa Garçom', 'rafa@bardamarina.com.br');
    expect((await waiter.fail('POST', '/api/stock/import', { csv: importTemplateCsv() })).status).toBe(403);
    const done = await c.ok('POST', '/api/stock/import', { csv: importTemplateCsv(), commit: true });
    expect(done.errors).toBe(0);
    expect(done.created).toBe(done.total);
  });
});
