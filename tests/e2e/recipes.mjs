// Fichas técnicas no navegador: insumo com saldo em kg, pratos que baixam o mesmo
// insumo (200 g e 300 g de batata), custo e margem, venda, alerta de mínimo e entrada em kg.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const port = 7468;
const base = `http://127.0.0.1:${port}`;
const out = resolve(process.argv[2] ?? join(repo, 'tests/e2e/screenshots/recipes'));
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, [join(repo, 'apps/server/dist/server.cjs'), '--data-dir', mkdtempSync(join(tmpdir(), 'rupbar-recipes-')), '--port', String(port)], { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, TZ: 'America/Sao_Paulo' } });
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
  const product = async (name) => (await request('GET', '/api/products')).find((p) => p.name === name);
  await request('POST', '/api/setup', { identity: { tradeName: 'Bar de teste', primaryColor: '#ff375f', secondaryColor: '#222538' }, owner: { name: 'Marina Souza', email: 'marina@example.com', password: 'Lua-Cheia-2026' } });
  await page.goto(base + '/fichas');
  await page.getByText('Nenhum prato com ficha técnica').waitFor();

  // 1. Insumo: 5 kg de batata a R$ 12/kg, mínimo de 1 kg. Já abre em kg e na categoria Insumos.
  await page.getByRole('button', { name: 'Novo insumo', exact: true }).click();
  await modal.getByLabel('Nome do insumo').fill('Batata congelada');
  assert.equal(await modal.getByLabel('Categoria', { exact: true }).locator('option:checked').textContent(), 'Insumos');
  await modal.getByLabel('Quantidade em estoque agora', { exact: true }).fill('5');
  assert.equal(await toggle('Quantidade em estoque agora', 'kg').getAttribute('aria-pressed'), 'true');
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('12,00');
  await modal.getByText('Você está cadastrando 5 kg = 5.000 g = 5 pacotes.').waitFor();
  await modal.getByLabel('Estoque mínimo', { exact: true }).fill('1');
  await page.screenshot({ path: join(out, '01-novo-insumo.png') });
  await modal.getByRole('button', { name: 'Cadastrar insumo' }).click();
  const batataRow = page.getByRole('row').filter({ hasText: 'Batata congelada' });
  await batataRow.getByText('5 kg', { exact: true }).waitFor();
  await batataRow.getByText('R$ 12,00/kg').waitFor();
  let batata = await product('Batata congelada');
  assert.equal(batata.stockQty, 5_000_000, '5 kg guardados como 5.000 g (em milésimos)');
  assert.equal(batata.minStock, 1_000_000);
  assert.equal(batata.menuVisible, false);
  assert.deepEqual(batata.presentations, []);

  // 2. Cheddar: 1 kg por R$ 40 (total).
  await page.getByRole('button', { name: 'Novo insumo', exact: true }).click();
  await modal.getByLabel('Nome do insumo').fill('Cheddar');
  await modal.getByLabel('Quantidade em estoque agora', { exact: true }).fill('1');
  await modal.getByRole('group', { name: 'Quanto você pagou?: valor' }).getByRole('button', { name: 'Total', exact: true }).click();
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('40,00');
  await modal.getByRole('button', { name: 'Cadastrar insumo' }).click();
  await page.getByRole('row').filter({ hasText: 'Cheddar' }).getByText('R$ 40,00/kg').waitFor();
  const cheddar = await product('Cheddar');

  // 3. Prato com 200 g de batata: custo R$ 2,40, margem e quantos dá para fazer.
  await page.getByRole('button', { name: 'Nova ficha técnica' }).click();
  await modal.getByLabel('Nome do prato').fill('Porção de batata');
  assert.equal(await modal.getByLabel('Categoria', { exact: true }).locator('option:checked').textContent(), 'Porções');
  await modal.getByLabel('Preço de venda').fill('25,00');
  await modal.getByLabel('Insumo 1', { exact: true }).selectOption(batata.id);
  await modal.locator('.recipe-qty input').first().fill('200');
  await modal.locator('.recipe-summary').getByText('R$ 2,40').waitFor();
  assert.match(await modal.locator('.recipe-summary').innerText(), /Custo R\$ 2,40 · margem 90% · dá para fazer 25/);
  await modal.getByRole('button', { name: 'Cadastrar prato' }).click();
  await page.getByRole('row').filter({ hasText: 'Porção de batata' }).getByText('Batata congelada 200 g').waitFor();

  // 4. Prato com 0,3 kg de batata + 50 g de cheddar (mesmo estoque de batata).
  await page.getByRole('button', { name: 'Nova ficha técnica' }).click();
  await modal.getByLabel('Nome do prato').fill('Batata com cheddar');
  await modal.getByLabel('Preço de venda').fill('38,00');
  await modal.getByLabel('Insumo 1', { exact: true }).selectOption(batata.id);
  await modal.locator('.recipe-qty input').first().fill('0,3');
  await modal.getByLabel('Unidade do insumo 1').selectOption('kilo');
  await modal.getByRole('button', { name: 'Adicionar insumo' }).click();
  await modal.getByLabel('Insumo 2', { exact: true }).selectOption(cheddar.id);
  await modal.locator('.recipe-qty input').nth(1).fill('50');
  assert.match(await modal.locator('.recipe-summary').innerText(), /Custo R\$ 5,60 · margem 85% · dá para fazer 16/);
  await page.screenshot({ path: join(out, '02-nova-ficha.png') });
  await modal.getByRole('button', { name: 'Cadastrar prato' }).click();
  const cheddarDish = page.getByRole('row').filter({ hasText: 'Batata com cheddar' }).first();
  await cheddarDish.getByText('Batata congelada 300 g + Cheddar 50 g').waitFor();
  await batataRow.getByText('Batata com cheddar, Porção de batata').waitFor();
  const simples = await product('Porção de batata');
  const completa = await product('Batata com cheddar');
  assert.equal(simples.stockTracked, false, 'prato sem estoque próprio');
  assert.equal(completa.presentations[0].costCents, 560);

  // 5. Venda: 2 porções + 1 com cheddar = 700 g de batata. A tela atualiza sozinha.
  const comanda = await request('POST', '/api/comandas', { customerName: 'Lia' });
  const order = (items) => request('POST', '/api/orders', { comandaId: comanda.id, clientRequestId: crypto.randomUUID(), items });
  await order([{ presentationId: simples.presentations[0].id, quantity: 2 }, { presentationId: completa.presentations[0].id, quantity: 1 }]);
  await batataRow.getByText('4,3 kg', { exact: true }).waitFor();
  assert.equal((await product('Batata congelada')).stockQty, 4_300_000);
  assert.equal((await product('Cheddar')).stockQty, 950_000);

  // 6. Ajustar a ficha: porção passa a 250 g e R$ 27.
  await page.getByRole('row').filter({ hasText: 'Porção de batata' }).first().click();
  await modal.locator('.recipe-qty input').first().fill('250');
  await modal.getByLabel('Preço de venda').fill('27,00');
  await modal.getByRole('button', { name: 'Salvar ficha' }).click();
  await page.getByRole('row').filter({ hasText: 'Porção de batata' }).getByText('Batata congelada 250 g').waitFor();
  assert.equal((await product('Porção de batata')).presentations[0].priceCents, 2_700);

  // 7. Abaixo do mínimo: 11 com cheddar levam a batata a 1 kg → aviso na tela.
  await order([{ presentationId: completa.presentations[0].id, quantity: 11 }]);
  await page.getByText('1 insumo abaixo do mínimo').waitFor();
  await page.getByText('Batata congelada (1 kg)').waitFor();
  await page.screenshot({ path: join(out, '03-alerta-minimo.png'), fullPage: true });

  // 8. Entrada em kg pela linha do insumo: 5 kg por R$ 60 no total.
  await batataRow.getByRole('button', { name: 'Entrada', exact: true }).click();
  assert.equal(await modal.getByLabel('Produto', { exact: true }).inputValue(), batata.id);
  await toggle('Quantidade que chegou', 'kg').click();
  await modal.getByLabel('Quantidade que chegou', { exact: true }).fill('5');
  await modal.getByRole('group', { name: 'Quanto você pagou?: valor' }).getByRole('button', { name: 'Total', exact: true }).click();
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('60,00');
  await modal.getByText('Você está lançando 5 kg = 5.000 g = 5 pacotes.').waitFor();
  await page.screenshot({ path: join(out, '04-entrada-kg.png') });
  await modal.getByRole('button', { name: 'Registrar entrada' }).click();
  await batataRow.getByText('6 kg', { exact: true }).waitFor();
  await page.getByText('1 insumo abaixo do mínimo').waitFor({ state: 'detached' });
  batata = await product('Batata congelada');
  assert.equal(batata.stockQty, 6_000_000);

  // 9. Celular e tema claro: sem rolagem lateral.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await page.getByRole('row').filter({ hasText: 'Batata com cheddar' }).first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `fichas não devem transbordar no celular (${overflow}px)`);
  await page.screenshot({ path: join(out, '05-fichas-celular.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Fichas técnicas E2E OK — insumo em kg, dois pratos do mesmo insumo, custo e margem, venda, ajuste da ficha, alerta de mínimo, entrada em kg e celular. Capturas em ${out}`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser?.close(); server.stdin.write('shutdown\n'); setTimeout(() => server.kill(), 3000).unref(); }
