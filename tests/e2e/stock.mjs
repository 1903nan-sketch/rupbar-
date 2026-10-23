// Fluxo real do cadastro rápido e da reposição de estoque, em PC e celular:
// "como você compra" (fardo, garrafa, pacote), embalagem × unidade, frase de
// conferência, aviso de engano, código automático, filtros e importação de planilha.
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

  // 4. Whisky em garrafa de 1.000 ml vendido em doses de 50 ml, com o energético
  //    escolhido no pedido (preço à parte e baixa da lata).
  const cats = await request('GET', '/api/categories');
  const redbull = await request('POST', '/api/products', { name: 'Red Bull lata', internalCode: 'RB-LATA', categoryId: cats.find((c) => c.name === 'Destilados').id, measure: 'unit', menuVisible: false });
  await page.getByRole('button', { name: 'Novo produto', exact: true }).click();
  await modal.getByRole('button', { name: /Garrafa de X ml/ }).click();
  await modal.getByLabel('Nome do produto', { exact: true }).fill('Whisky teste');
  await modal.getByLabel('Categoria', { exact: true }).selectOption({ label: 'Destilados' });
  await modal.getByLabel('Preço da dose').fill('29,90');
  await modal.getByLabel('Quantidade em estoque agora', { exact: true }).fill('2');
  await modal.getByLabel('Quanto você pagou?', { exact: true }).fill('150,00');
  await modal.getByText('2 garrafas de 1.000 ml = 2.000 ml = 40 doses de 50 ml', { exact: false }).waitFor();
  await modal.getByRole('button', { name: 'Criar nova escolha' }).click();
  await modal.getByLabel('Nome da escolha').fill('Energético');
  await modal.getByLabel('Opção', { exact: true }).first().fill('Red Bull');
  await modal.getByLabel('Preço a mais').first().fill('8,00');
  await modal.getByLabel('Baixa do estoque').first().selectOption({ label: 'Red Bull lata' });
  await modal.getByRole('button', { name: 'Opção', exact: true }).click();
  await modal.getByLabel('Opção', { exact: true }).nth(1).fill('Sem energético');
  await modal.getByRole('button', { name: 'Criar e adicionar' }).click();
  await modal.locator('.option-group-card', { hasText: 'Red Bull +R$' }).waitFor();
  await modal.locator('.option-groups-field').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, '03b-escolhas-no-cadastro.png') });
  await modal.getByRole('button', { name: 'Cadastrar produto', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'Whisky teste' }).waitFor();
  const whisky = (await request('GET', '/api/products')).find((p) => p.name === 'Whisky teste');
  assert.equal(whisky.stockQty, 2_000_000);
  assert.equal(whisky.presentations[0].components[0].qty, 50_000);
  assert.equal(whisky.presentations[0].available, 40);
  assert.equal(whisky.internalCode, '0002');
  const [energy] = await request('GET', '/api/option-groups');
  assert.deepEqual(whisky.optionGroupIds, [energy.id]);
  assert.deepEqual(energy.choices.map((c) => [c.name, c.priceDeltaCents, c.productId, c.qty]), [['Red Bull', 800, redbull.id, 1000], ['Sem energético', 0, null, 0]]);
  await page.getByRole('row').filter({ hasText: 'Whisky teste' }).getByText('2 garrafas').waitFor();
  await page.waitForFunction(() => !document.querySelector('.toast'));
  await page.screenshot({ path: join(out, '03-estoque-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(out, '04-estoque-light.png') });

  // 4b. Combo: a garrafa fechada + 4 latas do energético escolhido.
  await page.goto(base + '/produtos');
  await page.getByRole('button', { name: 'Novo combo' }).click();
  await modal.getByLabel('Nome do combo').fill('Combo Whisky');
  await modal.getByLabel('Preço do combo').fill('250,00');
  await modal.getByLabel('Produto', { exact: true }).selectOption({ label: 'Whisky teste' });
  await modal.getByText('= 1.000 ml').waitFor();
  await modal.getByLabel('Adicionar escolha já cadastrada').selectOption({ label: 'Energético (2 opções)' });
  for (let i = 0; i < 3; i++) await modal.getByRole('button', { name: 'Mais Energético' }).click();
  await modal.locator('.option-qty-row', { hasText: '4' }).waitFor();
  await page.screenshot({ path: join(out, '04b-novo-combo.png') });
  await modal.getByRole('button', { name: /Criar combo/ }).click();
  await modal.waitFor({ state: 'hidden' });
  const comboProduct = (await request('GET', '/api/products')).find((p) => p.name === 'Combo Whisky');
  assert.deepEqual(comboProduct.presentations[0].components.map((c) => [c.productId, c.qty]), [[whisky.id, 1_000_000]]);
  assert.equal(comboProduct.presentations[0].priceCents, 25_000);
  assert.deepEqual(comboProduct.optionGroups, [{ groupId: energy.id, quantity: 4 }]);
  await page.goto(base + '/estoque');

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
  assert.equal(ingredient.internalCode, '0004'); // 0003 ficou com o combo
  await page.waitForFunction(() => !document.querySelector('.toast'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'estoque não deve transbordar no celular');
  await page.screenshot({ path: join(out, '06-estoque-mobile.png'), fullPage: true });

  // 6. Importar a contagem por planilha salva pelo Excel (CSV em Windows-1252):
  //    um já cadastrado (atualiza a contagem), um novo e uma linha com erro.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Importar planilha', exact: true }).click();
  const download = page.waitForEvent('download');
  await modal.getByRole('button', { name: 'Baixar modelo (.csv)' }).click();
  assert.equal((await download).suggestedFilename(), 'modelo-estoque-rupbar.csv');
  const sheet = [
    'Produto;Como compra;Qtd embalagem;Fechados;Soltos;Custo;Preço de venda',
    'cerveja TESTE;fardo;12;1;3;54,00;12,00',
    'Água com gás;unidade;;;20;1,80;5,00',
    'Linha errada;barril;;;;;',
  ].join('\r\n');
  await modal.getByLabel('Arquivo da planilha').setInputFiles({ name: 'contagem.csv', mimeType: 'text/csv', buffer: Buffer.from(sheet, 'latin1') });
  const importRow = (name) => modal.locator('.import-row', { hasText: name });
  await importRow('cerveja TESTE').getByText('Já cadastrado pelo nome: Cerveja teste').waitFor();
  await importRow('cerveja TESTE').getByText('15 latas (1 fardo + 3 latas)').waitFor();
  await importRow('Água com gás').getByText('Novo', { exact: true }).waitFor();
  await importRow('Linha errada').getByText(/unidade, fardo, garrafa ou pacote/).waitFor();
  await page.screenshot({ path: join(out, '07-importar-planilha.png') });
  await modal.getByRole('button', { name: 'Importar 2 produtos' }).click();
  await page.getByRole('heading', { name: 'Planilha importada' }).waitFor();
  await page.getByRole('button', { name: 'Ver o estoque' }).click();
  await modal.waitFor({ state: 'hidden' });
  const afterImport = await request('GET', '/api/products');
  assert.equal(afterImport.find((p) => p.name === 'Cerveja teste').stockQty, 15_000);
  const water = afterImport.find((p) => p.name === 'Água com gás');
  assert.equal(water.stockQty, 20_000);
  assert.equal(water.categoryName, 'Outros');
  assert.deepEqual(water.presentations.map((p) => [p.name, p.priceCents]), [['Unidade', 500]]);
  await page.getByRole('row').filter({ hasText: 'Água com gás' }).getByText('20 unidades').waitFor();

  // 6b. Ingrediente que passa a ser vendido: a apresentação já vem com o nome do
  //     produto, ele volta ao cardápio e a lista de venda não repete o nome.
  await page.goto(base + '/produtos');
  await page.getByRole('row').filter({ hasText: 'Ingrediente teste' }).click();
  await modal.getByRole('button', { name: /Apresentações e preços/ }).click();
  await modal.getByRole('button', { name: 'Adicionar apresentação' }).click();
  assert.equal(await modal.getByLabel('Nome', { exact: true }).inputValue(), 'Ingrediente teste');
  await modal.getByLabel('Preço de venda').fill('9,00');
  await modal.getByRole('button', { name: 'Salvar', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const sold = (await request('GET', '/api/menu')).items.find((i) => i.productName === 'Ingrediente teste');
  assert.equal(sold?.presentationName, 'Ingrediente teste');
  assert.equal(sold?.priceCents, 900);
  await page.getByRole('button', { name: 'Venda rápida' }).first().click();
  await modal.getByLabel('Buscar produto').fill('Ingrediente teste');
  const tile = modal.locator('.menu-tile', { hasText: 'Ingrediente teste' });
  await tile.waitFor();
  assert.equal(await tile.locator('.menu-tile-pres').count(), 0, 'não repete o nome do produto');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // 6c. Mesma garrafa: dose pura e "Dose com energético" (só ela pede o energético).
  await page.goto(base + '/produtos');
  await page.getByRole('row').filter({ hasText: 'Whisky teste' }).click();
  await modal.getByRole('button', { name: /Escolhas no pedido/ }).click();
  await modal.getByRole('button', { name: 'Tirar Energético deste produto' }).click();
  await modal.getByRole('button', { name: /Apresentações e preços/ }).click();
  await modal.getByRole('button', { name: 'Adicionar apresentação' }).click();
  await modal.getByLabel('Nome', { exact: true }).last().fill('Dose com energético');
  await modal.getByLabel('Preço de venda').last().fill('29,90');
  await modal.getByRole('button', { name: /Escolhas só desta apresentação/ }).last().click();
  await modal.getByLabel('Adicionar escolha já cadastrada').last().selectOption({ label: 'Energético (2 opções)' });
  await modal.locator('.pres-options .option-group-card', { hasText: 'Energético' }).waitFor();
  await page.screenshot({ path: join(out, '07b-escolha-so-da-dose.png') });
  await modal.getByRole('button', { name: 'Salvar', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const menu = await request('GET', '/api/menu');
  const whiskyItem = (name) => menu.items.find((i) => i.productId === whisky.id && i.presentationName === name);
  assert.deepEqual(whiskyItem('Dose 50 ml').optionGroupIds, []);
  assert.deepEqual(whiskyItem('Dose com energético').optionGroupIds, [energy.id]);

  // 6d. Meio a meio na hora do pedido (sem cadastro): meia polenta + meia batata, cobra a mais cara.
  const portionsCat = cats.find((c) => c.name === 'Porções').id;
  const portion = async (name, priceCents) => {
    const base = await request('POST', '/api/products', { name: `${name} crua`, categoryId: portionsCat, measure: 'mass', packageQty: 1_000_000, menuVisible: false, initialStock: { qty: 2_000_000, totalCostCents: 2_000 } });
    await request('POST', '/api/products', { name, categoryId: portionsCat, measure: 'unit', stockTracked: false, presentations: [{ name, priceCents, components: [{ productId: base.id, qty: 400_000 }] }] });
    return base;
  };
  const batataCrua = await portion('Porção batata', 3500);
  await portion('Porção polenta', 3000);
  await page.reload();
  await page.getByRole('button', { name: 'Venda rápida' }).first().click();
  await modal.getByRole('button', { name: 'Meio a meio' }).click();
  await modal.getByText('toque na 1ª metade', { exact: false }).waitFor();
  assert.equal(await modal.locator('.menu-tile', { hasText: 'Whisky teste' }).count(), 0, 'meio a meio mostra só comida');
  await modal.getByRole('button', { name: /Adicionar Porção polenta/ }).click();
  await modal.getByText('Toque na 2ª metade', { exact: false }).waitFor();
  await page.screenshot({ path: join(out, '07c-meio-a-meio-na-hora.png') });
  await modal.getByRole('button', { name: /Adicionar Porção batata/ }).click();
  await page.locator('.cart-line', { hasText: '½ Porção polenta · ½ Porção batata' }).getByText('R$ 35,00').waitFor();
  await page.screenshot({ path: join(out, '07d-meio-a-meio-no-carrinho.png') });
  await page.locator('.cart-line').getByRole('button', { name: 'Remover' }).click();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  assert.equal((await request('GET', `/api/products/${batataCrua.id}`)).stockQty, 2_000_000, 'carrinho não baixa estoque');

  // 6e. Balde de cerveja: escolhe o balde e depois a cerveja; cada cerveja tem o preço do balde dela.
  await page.goto(base + '/produtos');
  await page.getByRole('button', { name: 'Novo balde' }).click();
  await modal.getByLabel('Cerveja 1').selectOption({ label: 'Cerveja teste' });
  await modal.getByLabel('Preço do balde').first().fill('55,00');
  await modal.getByRole('button', { name: 'Cerveja', exact: true }).click();
  await modal.getByLabel('Cerveja 2').selectOption({ label: 'Água com gás' });
  await modal.getByLabel('Preço do balde').nth(1).fill('30,00');
  await page.screenshot({ path: join(out, '07e-novo-balde.png') });
  await modal.getByRole('button', { name: 'Criar balde' }).click();
  await modal.waitFor({ state: 'hidden' });
  const bucketItem = (await request('GET', '/api/menu')).items.find((i) => i.productName === 'Balde de cerveja');
  assert.equal(bucketItem?.priceCents, 0);
  assert.equal(bucketItem?.optionGroupIds.length, 1);
  await page.getByRole('button', { name: 'Venda rápida' }).first().click();
  await modal.getByLabel('Buscar produto').fill('Balde');
  const bucketTile = modal.locator('.menu-tile', { hasText: 'Balde de cerveja' });
  await bucketTile.getByText('a partir de R$ 30,00').waitFor();
  await bucketTile.click();
  const chooser = page.locator('.modal', { has: page.locator('.option-chooser') });
  await chooser.getByRole('radio', { name: /Cerveja teste\s*R\$ 55,00/ }).click();
  await page.screenshot({ path: join(out, '07f-balde-escolhe-cerveja.png') });
  await chooser.getByRole('button', { name: 'Adicionar R$ 55,00' }).click();
  await page.locator('.cart-line', { hasText: 'Balde de cerveja' }).getByText('R$ 55,00').waitFor();
  await page.locator('.cart-line').getByRole('button', { name: 'Remover' }).click();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // 6f. Comanda de funcionário: baixa o estoque, não cobra e fica fora das vendas.
  await page.goto(base + '/comandas');
  await page.getByRole('button', { name: 'Nova comanda' }).click();
  await modal.getByRole('tab', { name: 'Funcionário' }).click();
  await modal.getByLabel('Funcionário que vai consumir').selectOption({ label: 'Marina Souza' });
  await modal.getByRole('button', { name: 'Abrir consumo' }).click();
  await page.getByText('Consumo de funcionário: baixa o estoque').waitFor();
  const staffComanda = (await request('GET', '/api/comandas')).find((c) => c.kind === 'staff');
  const beerItem = (await request('GET', '/api/menu')).items.find((i) => i.productName === 'Cerveja teste');
  const beforeStaff = (await request('GET', '/api/products')).find((p) => p.name === 'Cerveja teste').stockQty;
  await request('POST', '/api/orders', { comandaId: staffComanda.id, clientRequestId: crypto.randomUUID(), items: [{ presentationId: beerItem.presentationId, quantity: 2 }] });
  await page.reload();
  await page.getByText('Consumido (preço de cardápio)').waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(out, '07g-consumo-funcionario.png') });
  await page.getByRole('button', { name: 'Encerrar consumo' }).click();
  await modal.getByRole('button', { name: 'Encerrar', exact: true }).click();
  await page.getByText('Encerrada').first().waitFor();
  assert.equal((await request('GET', '/api/products')).find((p) => p.name === 'Cerveja teste').stockQty, beforeStaff - 2_000, 'consumo baixa o estoque');
  const salesNow = await request('GET', '/api/reports/sales?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z');
  assert.equal(salesNow.grossCents, 0, 'consumo de funcionário fora das vendas');
  assert.deepEqual(salesNow.staffConsumption.map((r) => [r.name, r.items, r.value]), [['Marina Souza', 2, 2_400]]);

  // 6f2. Trocar item lançado: acabou a cerveja, entra a água com gás (PC e celular).
  const swapComanda = await request('POST', '/api/comandas', { customerName: 'Troca' });
  await request('POST', '/api/orders', { comandaId: swapComanda.id, clientRequestId: crypto.randomUUID(), items: [{ presentationId: beerItem.presentationId, quantity: 2 }] });
  await page.goto(`${base}/comandas/${swapComanda.id}`);
  await page.getByRole('button', { name: 'Trocar Cerveja teste' }).click();
  await modal.getByText('2× Cerveja teste').waitFor();
  await modal.getByLabel('Buscar produto').fill('Água com gás');
  await modal.getByRole('button', { name: /Adicionar Água com gás/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, '07h-trocar-item.png') });
  await modal.getByRole('button', { name: /^Trocar · R\$ 10,00/ }).click();
  await modal.waitFor({ state: 'hidden' });
  const swapped = await request('GET', `/api/comandas/${swapComanda.id}`);
  assert.deepEqual(swapped.items.map((i) => [i.name, i.quantity, i.status]), [['Cerveja teste', 2, 'canceled'], ['Água com gás', 2, 'active']]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/m/comanda/${swapComanda.id}`);
  await page.getByRole('button', { name: /Já lançados · 2 itens/ }).click();
  await page.getByRole('button', { name: 'Trocar Água com gás' }).waitFor();
  await page.screenshot({ path: join(out, '07i-trocar-no-celular.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 6g. Excluir produto: lixeira na lista de Produtos, com confirmação.
  await page.goto(base + '/produtos');
  await page.getByRole('row').filter({ hasText: 'Água com gás' }).getByRole('button', { name: 'Excluir Água com gás' }).click();
  await modal.getByText('Ainda tem').waitFor();
  await modal.getByRole('button', { name: 'Excluir produto' }).click();
  await page.getByRole('row').filter({ hasText: 'Água com gás' }).waitFor({ state: 'detached' });
  assert.equal((await request('GET', '/api/products?all=1')).some((p) => p.name === 'Água com gás'), false);

  // 7. Conta mestre: apagar os dados de teste (estoque, produtos e relatórios).
  await page.goto(base + '/configuracoes');
  await page.getByRole('link', { name: /Apagar dados de teste/ }).click();
  await page.getByText(/produtos com preços, combos/).waitFor();
  const eraseButton = page.getByRole('button', { name: 'Apagar dados de teste' });
  assert(await eraseButton.isDisabled(), 'só libera com senha e APAGAR');
  await page.getByLabel('Sua senha (proprietário)').fill('Lua-Cheia-2026');
  await page.getByLabel('Digite APAGAR').fill('apagar');
  await page.screenshot({ path: join(out, '08-apagar-testes.png') });
  await eraseButton.click();
  await page.getByText('Pronto: o sistema está zerado para começar').waitFor();
  assert.deepEqual(await request('GET', '/api/products'), []);
  assert.equal((await request('GET', '/api/admin/test-data')).stockMovements, 0);
  await page.getByRole('link', { name: 'Importar a planilha do estoque' }).click();
  await page.getByText('Vamos cadastrar seu estoque?').waitFor();
  assert.deepEqual(errors, []);
  console.log(`Estoque E2E OK — fardo × lata, aviso de engano, garrafa e doses, ingrediente, código automático, filtros, celular, importação de planilha, escolha só da dose, meio a meio na hora, balde de cerveja, consumo de funcionário, trocar item, excluir produto e apagar dados de teste. Capturas em ${out}`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser?.close(); server.stdin.write('shutdown\n'); setTimeout(() => server.kill(), 3000).unref(); }
