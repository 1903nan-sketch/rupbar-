// Fluxo real do cadastro rápido e da reposição de estoque, em PC e celular:
// "como você compra" (fardo, garrafa, pacote), embalagem × unidade, frase de
// conferência, aviso de engano, código automático e filtros.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const port = 7467;
const base = `http://127.0.0.1:${port}`;
const out = resolve(process.argv[2] ?? join(repo, 'tests/e2e/screenshots/stock'));
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, [join(repo, 'apps/server/dist/server.cjs'), '--data-dir', mkdtempSync(join(tmpdir(), 'rupbar-stock-')), '--port', String(port)], { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, TZ: 'America/Sao_Paulo' } });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(ready, 'servidor deve iniciar');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const request = async (method, path, data) => {
    const res = await page.request.fetch(base + path, { method, headers: { 'x-rupbar': '1' }, data });
    assert(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`);
    return res.json();
  };
  const modal = page.locator('.modal');
  const toggle = (label, option) => modal.getByRole('group', { name: `${label}: contar em` }).getByRole('button', { name: option, exact: true });
  await request('POST', '/api/setup', { identity: { tradeName: 'Bar de teste', primaryColor: '#ff375f', secondaryColor: '#222538' }, owner: { name: 'Marina Souza', email: 'marina@example.com', password: 'Lua-Cheia-2026' } });
  await page.goto(base + '/estoque');

  // 1. Cerveja comprada em fardo de 12 latas, saldo informado em fardos e custo por fardo.
  await page.getByRole('button', { name: 'Novo produto', exact: true }).click();
  await modal.getByLabel('Nome do produto', { exact: true }).fill('Cerveja teste');
  await modal.getByLabel('Categoria', { exact: true }).selectOption({ label: 'Cervejas' });
  await modal.getByRole('group', { name: 'Como você compra este produto?' }).getByRole('button', { name: /Fardo, caixa ou pacote/ }).click();
  await modal.getByText('1 fardo = 12 latas').waitFor();
  await modal.getByLabel('Preço de 1 lata').fill('12,00');
  await modal.getByLabel('Quantidade em estoque agora', { exact: true }).fill('2');
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('54,00');
  await modal.getByText('Você está cadastrando 2 fardos de 12 = 24 latas.').waitFor();
  await modal.getByText('Custo por lata: R$ 4,50').waitFor();
  await modal.getByLabel('Estoque mínimo', { exact: true }).fill('6');
  await toggle('Estoque mínimo', 'Latas').click();
  await page.screenshot({ path: join(out, '01-cadastro-rapido-dark.png') });
  await modal.getByRole('button', { name: 'Cadastrar produto', exact: true }).click();
  const cervejaRow = page.getByRole('row').filter({ hasText: 'Cerveja teste' });
  await cervejaRow.waitFor();
  let product = (await request('GET', '/api/products')).find((p) => p.name === 'Cerveja teste');
  assert.equal(product.stockQty, 24_000);
  assert.equal(product.unitCostE4, 4_500_000);
  assert.equal(product.minStock, 6_000);
  assert.equal(product.packageQty, 12_000);
  assert.equal(product.unitLabel, 'lata');
  assert.equal(product.internalCode, '0001', 'código interno gerado automaticamente');
  await cervejaRow.getByText('24 latas').waitFor();
  await cervejaRow.getByText('(2 fardos)').waitFor();
  await cervejaRow.getByText('#0001').waitFor();

  // 2. Reposição em latas soltas: aviso de engano ao digitar 2 latas, total pago.
  await cervejaRow.getByRole('button', { name: 'Entrada', exact: true }).click();
  assert.equal(await modal.getByLabel('Produto', { exact: true }).inputValue(), product.id);
  await toggle('Quantidade que chegou', 'Latas').click();
  await modal.getByLabel('Quantidade que chegou', { exact: true }).fill('2');
  await modal.getByText('Você quis dizer 2 fardos (24 latas)?').waitFor();
  await modal.getByLabel('Quantidade que chegou', { exact: true }).fill('6');
  await modal.getByRole('button', { name: 'Não, está certo' }).click();
  await modal.getByRole('group', { name: 'Quanto você pagou?: valor' }).getByRole('button', { name: 'Total', exact: true }).click();
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('27,00');
  await modal.getByText('Você está lançando 6 latas.').waitFor();
  await modal.getByText('Custo por lata: R$ 4,50').waitFor();
  await page.screenshot({ path: join(out, '02-reposicao-dark.png') });
  await modal.getByRole('button', { name: 'Registrar entrada', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  product = await request('GET', `/api/products/${product.id}`);
  assert.equal(product.stockQty, 30_000);
  await page.reload();
  await cervejaRow.getByText('(2 fardos + 6 latas)').waitFor();
  assert.equal((await request('GET', `/api/products/${product.id}`)).stockQty, 30_000);
  assert.equal((await request('GET', '/api/stock/purchases')).length, 2);

  // 3. Filtros: situação, busca por nome e por código.
  const levels = page.getByRole('group', { name: 'Situação do estoque' });
  await levels.getByRole('button', { name: /Zerado/ }).click();
  await page.getByText('Nenhum produto neste filtro').waitFor();
  await page.getByRole('button', { name: 'Limpar filtros' }).first().click();
  await cervejaRow.waitFor();
  await page.getByLabel('Buscar no estoque').fill('inexistente');
  await page.getByText('Nenhum produto neste filtro').waitFor();
  await page.getByLabel('Buscar no estoque').fill('1');
  await cervejaRow.waitFor();
  await page.getByLabel('Buscar no estoque').fill('');

  // 4. Whisky em garrafa de 1.000 ml vendido em doses de 50 ml.
  await page.getByRole('button', { name: 'Novo produto', exact: true }).click();
  await modal.getByRole('button', { name: /Garrafa de X ml/ }).click();
  await modal.getByLabel('Nome do produto', { exact: true }).fill('Whisky teste');
  await modal.getByLabel('Categoria', { exact: true }).selectOption({ label: 'Destilados' });
  await modal.getByLabel('Preço da dose').fill('29,90');
  await modal.getByLabel('Quantidade em estoque agora', { exact: true }).fill('2');
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('150,00');
  await modal.getByText('2 garrafas de 1.000 ml = 2.000 ml = 40 doses de 50 ml', { exact: false }).waitFor();
  await modal.getByRole('button', { name: 'Cadastrar produto', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'Whisky teste' }).waitFor();
  const whisky = (await request('GET', '/api/products')).find((p) => p.name === 'Whisky teste');
  assert.equal(whisky.stockQty, 2_000_000);
  assert.equal(whisky.presentations[0].components[0].qty, 50_000);
  assert.equal(whisky.presentations[0].available, 40);
  assert.equal(whisky.internalCode, '0002');
  await page.getByRole('row').filter({ hasText: 'Whisky teste' }).getByText('2 garrafas').waitFor();
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(out, '03-estoque-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(out, '04-estoque-light.png') });

  // 5. Celular: ingrediente em pacote de 50 g, sem venda no cardápio.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Novo produto', exact: true }).click();
  await modal.getByRole('button', { name: /Pacote de X g/ }).click();
  await modal.getByLabel('Nome do produto', { exact: true }).fill('Ingrediente teste');
  await modal.getByLabel('Quantidade em estoque agora', { exact: true }).fill('4');
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('10,00');
  assert.equal(await modal.getByRole('button', { name: /Só no narguilé ou em receitas/ }).getAttribute('aria-pressed'), 'true');
  assert(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth), 'modal não deve transbordar no celular');
  await page.screenshot({ path: join(out, '05-cadastro-mobile.png') });
  await modal.getByRole('button', { name: 'Cadastrar produto', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const ingredient = (await request('GET', '/api/products')).find((p) => p.name === 'Ingrediente teste');
  assert.equal(ingredient.stockQty, 200_000);
  assert.equal(ingredient.menuVisible, false);
  assert.equal(ingredient.presentations.length, 0);
  assert.equal(ingredient.internalCode, '0003');
  await page.locator('.toast').waitFor({ state: 'hidden' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'estoque não deve transbordar no celular');
  await page.screenshot({ path: join(out, '06-estoque-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Estoque E2E OK — fardo × lata, aviso de engano, garrafa e doses, ingrediente, código automático, filtros e celular. Capturas em ${out}`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser?.close(); server.stdin.write('shutdown\n'); setTimeout(() => server.kill(), 3000).unref(); }
