// Teste ponta a ponta do RupBar em um navegador real (Chromium).
//
// Sobe o servidor empacotado (apps/server/dist/server.cjs) com uma pasta de
// dados temporária e percorre: configuração inicial → cadastro de produto com
// doses → comanda → pedido → cozinha → TV (pareamento e chamada) → celular do
// garçom (senha temporária, cardápio e envio). Falha se houver erro de página.
//
// Uso: pnpm --filter @rupbar/local-ui build && pnpm --filter @rupbar/server bundle
//      node tests/e2e/smoke.mjs [pasta-de-capturas]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = resolve(process.argv[2] ?? join(repo, 'tests/e2e/screenshots'));
mkdirSync(out, { recursive: true });
const PORT = 7466;
const B = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'rupbar-e2e-'));

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'apps/server/dist/server.cjs'), '--data-dir', dataDir, '--port', String(PORT)], {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, TZ: 'America/Sao_Paulo' },
});

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${B}/api/health`);
      if (r.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('servidor não subiu');
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Falhou: ${msg}`);
}

const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401|Unauthorized/.test(m.text())) errors.push(`${tag} console: ${m.text()}`);
  });
};

let browser;
try {
  await waitHealth();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  watch(page, 'pc');

  // 1. Configuração inicial
  await page.goto(B + '/');
  await page.waitForURL('**/setup');
  await page.getByPlaceholder('Ex.: Bar do Zé').fill('Adega Lua Cheia');
  await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByRole('button', { name: /Continuar/ }).click();
  const inputs = page.locator('.setup-main input');
  await inputs.nth(0).fill('Marina Souza');
  await inputs.nth(1).fill('marina@adega.com.br');
  await inputs.nth(2).fill('Lua-Cheia-2026');
  await inputs.nth(3).fill('Lua-Cheia-2026');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByRole('button', { name: /Concluir configuração/ }).click();
  await page.waitForURL('**/configuracoes/dispositivos**');
  await page.waitForSelector('.qr img');
  await page.screenshot({ path: join(out, '01-conectar-dispositivo.png') });

  const api = async (method, url, data) => {
    const r = await page.request.fetch(B + url, { method, headers: { 'x-rupbar': '1' }, data });
    if (!r.ok()) throw new Error(`${method} ${url} ${r.status()} ${await r.text()}`);
    return r.json();
  };
  const cats = await api('GET', '/api/categories');
  const cat = (n) => cats.find((c) => c.name === n).id;

  // 2. Produtos e estoque
  const whisky = await api('POST', '/api/products', {
    name: 'Whisky 12 anos 1L', categoryId: cat('Destilados'), measure: 'volume', packageQty: 1_000_000, minStock: 300_000,
    presentations: [
      { name: 'Dose 50 ml', priceCents: 2990, components: [{ productId: null, qty: 50_000 }] },
      { name: 'Dose dupla 100 ml', priceCents: 5490, components: [{ productId: null, qty: 100_000 }] },
    ],
  });
  await api('POST', '/api/products', { name: 'Batata frita', categoryId: cat('Porções'), measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3890 }] });
  await api('POST', '/api/stock/purchases', { items: [{ productId: whisky.id, packages: 2, packageQty: 1_000_000, totalCostCents: 30_000 }] });
  await api('POST', '/api/cash/open', { openingBalanceCents: 10_000 });
  // Pix pela tela de configurações: na primeira vez já vem ligado.
  await page.goto(B + '/configuracoes/pix');
  await page.getByRole('radio', { name: 'Chave aleatória' }).click();
  await page.getByPlaceholder('123e4567-e89b-12d3-a456-426614174000').fill('123e4567-e12b-12d1-a456-426655440000');
  await page.getByPlaceholder('Bar da Marina').fill('Adega Lua Cheia');
  await page.getByPlaceholder('São Paulo').fill('São Paulo');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.getByText('Pix ligado').waitFor();
  assert((await api('GET', '/api/settings/pix')).enabled === true, 'o Pix deveria ficar ligado ao salvar a chave pela primeira vez');

  // 3. Comanda e pedido pela interface
  await page.goto(B + '/comandas');
  await page.getByRole('button', { name: 'Nova comanda' }).click();
  await page.locator('.modal input').nth(0).fill('12'); // número do cartão
  await page.locator('.modal input').nth(1).fill('Carlos Lima');
  await page.locator('.modal input').nth(2).fill('7');
  await page.getByRole('button', { name: 'Abrir comanda' }).click();
  await page.waitForURL(/\/comandas\/.+/);
  await page.getByRole('heading', { name: 'Comanda 12' }).waitFor();
  await page.getByRole('button', { name: 'Lançar itens' }).click();
  const modal = page.locator('.modal');
  await modal.locator('.menu-tile').first().waitFor();
  await modal.getByRole('button', { name: /Adicionar Whisky/ }).first().click();
  await modal.getByRole('button', { name: /Adicionar Batata/ }).click();
  await modal.getByRole('button', { name: 'Enviar pedido' }).click();
  await page.locator('text=Pedido 1').first().waitFor();
  await page.screenshot({ path: join(out, '02-comanda.png') });
  const stock = (await api('GET', `/api/products/${whisky.id}`)).stockQty;
  assert(stock === 1_950_000, `estoque após dose de 50 ml deveria ser 1.950.000, veio ${stock}`);

  // 4. Pagamento e encerramento pela interface
  await page.getByRole('button', { name: 'Receber pagamento' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Pix', exact: true }).click();
  await page.locator('.modal').getByRole('button', { name: /Confirmar/ }).click();
  await page.getByRole('button', { name: 'Encerrar comanda' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Encerrar' }).click();
  await page.locator('.badge', { hasText: 'Encerrada' }).waitFor();

  // 5. Produção e TV
  const tvCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const tv = await tvCtx.newPage();
  watch(tv, 'tv');
  await tv.goto(B + '/tv');
  await tv.waitForSelector('.ptv-code');
  const code = (await tv.locator('.ptv-code').textContent()).trim();
  await api('POST', '/api/tv/approve', { code, name: 'TV do balcão' });
  // Tela "Toque para iniciar" libera o som (pulada se o navegador já permite).
  await Promise.race([
    tv.getByRole('button', { name: 'Toque para iniciar' }).click(),
    tv.waitForSelector('.ptv-board'),
  ]);
  await tv.waitForSelector('.ptv-board');
  await page.goto(B + '/producao');
  const batata = page.locator('.kds-ticket', { hasText: 'Batata' });
  await batata.waitFor();
  assert((await batata.textContent()).includes('Comanda 12'), 'a produção deveria mostrar o número do cartão');
  await batata.getByRole('button', { name: 'Começar' }).click();
  await batata.getByRole('button', { name: 'Pronto' }).click();
  await batata.getByRole('button', { name: 'Chamar na TV' }).click();
  await tv.waitForSelector('.ptv-call', { timeout: 8000 });
  const callText = await tv.locator('.ptv-call').textContent();
  assert(callText.includes('Carlos'), 'TV deveria anunciar o nome');
  assert(callText.includes('12'), 'TV deveria mostrar o número da comanda');
  await tv.screenshot({ path: join(out, '03-tv-chamada.png') });
  await page.screenshot({ path: join(out, '04-producao.png') });

  // 5b. Venda rápida pela tela inicial: paga na hora e a TV chama pelo nome
  await page.goto(B + '/');
  await page.locator('.action-tile').first().waitFor();
  await page.waitForTimeout(700); // fim das animações de entrada
  await page.screenshot({ path: join(out, '00-inicio.png') });
  await page.getByRole('button', { name: /Venda rápida.*Balcão/ }).click();
  const quick = page.locator('.quick-sale');
  await quick.locator('.menu-tile').first().waitFor();
  await quick.getByRole('button', { name: /Adicionar Batata/ }).click();
  await quick.getByPlaceholder('Ex.: Juliana').fill('Juliana Prado');
  await quick.getByRole('radio', { name: 'Débito' }).click();
  await quick.getByRole('button', { name: /Finalizar/ }).click();
  await quick.locator('.quick-call-name', { hasText: 'Juliana' }).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, '04b-venda-rapida.png') });
  await quick.getByRole('button', { name: 'Fechar', exact: true }).last().click();
  await page.goto(B + '/producao');
  await page.locator('.kds-ticket', { hasText: 'Juliana' }).locator('.kds-tag', { hasText: 'Venda rápida' }).waitFor();

  // 5c. Lançar na comanda pelo número do cartão (atalho F3). O cartão 12 já
  // foi encerrado, então está livre: abre a comanda na hora e lança.
  await page.keyboard.press('F3');
  await page.getByLabel('Número da comanda').fill('12');
  await page.keyboard.press('Enter');
  await page.getByText('Nenhuma comanda aberta com o número 12').waitFor();
  await page.getByPlaceholder('Nome do cliente (opcional)').fill('Bruno');
  await page.getByRole('button', { name: 'Abrir comanda 12' }).click();
  const launch = page.locator('.quick-sale');
  await launch.locator('.launch-found', { hasText: 'Bruno' }).waitFor();
  await launch.getByRole('button', { name: /Adicionar Batata/ }).click();
  await launch.getByRole('button', { name: 'Enviar pedido' }).click();
  await launch.locator('.launch-found', { hasText: '1 item' }).waitFor();
  await page.screenshot({ path: join(out, '04c-lancar-na-comanda.png') });
  await page.keyboard.press('Escape');

  // 6. Garçom no celular
  const roles = await api('GET', '/api/roles');
  const waiter = await api('POST', '/api/users', { name: 'João Garçom', email: 'joao@adega.com', roleId: roles.find((r) => r.key === 'waiter').id });
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await phoneCtx.newPage();
  watch(m, 'celular');
  await m.goto(B + '/login');
  await m.locator('input[type=email]').fill('joao@adega.com');
  await m.locator('input[type=password]').fill(waiter.temporaryPassword);
  await m.getByRole('button', { name: 'Entrar' }).click();
  await m.waitForURL('**/minha-senha');
  const pw = m.locator('input[type=password]');
  await pw.nth(0).fill(waiter.temporaryPassword);
  await pw.nth(1).fill('Garcom-Veloz-88');
  await pw.nth(2).fill('Garcom-Veloz-88');
  await m.getByRole('button', { name: 'Salvar senha' }).click();
  await m.waitForURL('**/m');
  // Cartão 30 livre: digitar o número abre a comanda na hora
  for (const d of ['3', '0']) await m.locator('.waiter-keys button', { hasText: new RegExp(`^${d}$`) }).click();
  await m.getByRole('button', { name: 'Abrir comanda', exact: true }).click();
  await m.getByRole('button', { name: 'Abrir comanda 30' }).click();
  await m.waitForURL(/\/m\/comanda\/.+/);
  await m.getByRole('button', { name: /Adicionar Whisky/ }).first().click();
  await m.getByRole('button', { name: 'Enviar' }).click();
  await m.getByText(/Pedido \d+ enviado/).waitFor();
  await m.screenshot({ path: join(out, '05-celular.png') });
  // Aba "Cobrar": garçom sem permissão de receber só pede a conta impressa.
  await m.getByRole('tab', { name: 'Cobrar' }).click();
  await m.getByRole('button', { name: 'Imprimir conta' }).waitFor();
  await m.screenshot({ path: join(out, '05b-celular-cobrar.png') });
  assert((await api('GET', `/api/products/${whisky.id}`)).stockQty === 1_900_000, 'pedido do celular deveria baixar mais 50 ml');

  assert(errors.length === 0, `erros no navegador:\n${errors.join('\n')}`);
  console.log(`E2E OK — capturas em ${out}`);
} catch (err) {
  console.error(err);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.stdin.write('shutdown\n');
  setTimeout(() => server.kill(), 3000).unref();
}
