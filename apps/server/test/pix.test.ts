import { isValidPixPayload, parseEmv } from '@rupbar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { category, Client, createEnv, createStaff, setupEstablishment, uuid, type TestEnv } from './helpers';

let env: TestEnv;
let owner: Client;

beforeEach(async () => {
  env = await createEnv();
  owner = await setupEstablishment(env);
});
afterEach(async () => {
  await env.app.close();
  env.s.close();
});

const PIX = { enabled: true, keyType: 'cpf', key: '529.982.247-25', merchantName: 'Bar da Marina', merchantCity: 'São Paulo' };
const field = (payload: string, id: string) => parseEmv(payload).find((f) => f.id === id)?.value;
const GS_K = [0x1d, 0x28, 0x6b];

function indexOfSeq(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Bytes da última conta enviada para a impressora. */
function jobBytes(printerId: string): Uint8Array {
  const row = env.s.db.get("SELECT payload FROM print_jobs WHERE printer_id = ? AND kind = 'receipt' AND status = 'done' ORDER BY created_at DESC LIMIT 1", printerId);
  return row!.payload as Uint8Array;
}

/** Comanda com 2 porções de R$ 30,00. */
async function comandaWithItems() {
  const porcoes = await category(owner, 'Porções');
  const p = await owner.ok('POST', '/api/products', {
    name: 'Batata frita', categoryId: porcoes, measure: 'unit', stockTracked: false, presentations: [{ name: 'Porção', priceCents: 3000 }],
  });
  const presentationId = (await owner.ok('GET', `/api/products/${p.id}`)).presentations[0].id;
  const c = await owner.ok('POST', '/api/comandas', { customerName: 'Carlos Lima', table: '7' });
  await owner.ok('POST', '/api/orders', { comandaId: c.id, clientRequestId: uuid(), items: [{ presentationId, quantity: 2 }] });
  return owner.ok('GET', `/api/comandas/${c.id}`);
}

describe('configuração do Pix', () => {
  it('começa desativado e valida chave, nome e cidade', async () => {
    expect(await owner.ok('GET', '/api/settings/pix')).toEqual({ enabled: false, keyType: 'cnpj', key: '', merchantName: '', merchantCity: '' });

    const badCpf = await owner.fail('PUT', '/api/settings/pix', { ...PIX, key: '529.982.247-26' });
    expect(badCpf).toMatchObject({ status: 400, code: 'VALIDATION' });
    expect(badCpf.message).toContain('CPF inválido');
    expect((await owner.fail('PUT', '/api/settings/pix', { ...PIX, keyType: 'phone', key: '(11) 3333-4444' })).message).toContain('Celular inválido');
    expect((await owner.fail('PUT', '/api/settings/pix', { ...PIX, merchantName: '' })).message).toContain('nome do recebedor');
    expect((await owner.fail('PUT', '/api/settings/pix', { ...PIX, merchantCity: '!!!' })).message).toContain('cidade');
    expect((await owner.fail('PUT', '/api/settings/pix', { ...PIX, key: '' })).message).toContain('chave Pix');
    expect((await owner.fail('PUT', '/api/settings/pix', { ...PIX, keyType: 'boleto' })).code).toBe('VALIDATION');
    // Desativado, dá para salvar um rascunho incompleto
    await owner.ok('PUT', '/api/settings/pix', { enabled: false, keyType: 'email', key: '', merchantName: 'Bar', merchantCity: '' });

    const saved = await owner.ok('PUT', '/api/settings/pix', PIX);
    expect(saved).toEqual({ ...PIX, key: '52998224725' }); // chave normalizada
    expect(await owner.ok('GET', '/api/settings/pix')).toEqual(saved);
    expect(await owner.ok('PUT', '/api/settings/pix', { ...PIX, keyType: 'phone', key: '+55 (11) 98765-4321' })).toMatchObject({ key: '+5511987654321' });
    expect(await owner.ok('PUT', '/api/settings/pix', { ...PIX, keyType: 'email', key: 'Pix@BarDaMarina.com.br' })).toMatchObject({ key: 'pix@bardamarina.com.br' });

    const audit = await owner.ok('GET', '/api/audit?action=settings.pix_updated');
    expect(audit.length).toBeGreaterThan(0);
  });

  it('permissões: só quem altera configurações salva; o caixa consulta; quem não recebe nem vê comandas não acessa', async () => {
    const cashier = await createStaff(env, owner, 'cashier', 'Rita Caixa', 'rita@bar.com');
    const waiter = await createStaff(env, owner, 'waiter', 'João Garçom', 'joao@bar.com');
    const kitchen = await createStaff(env, owner, 'kitchen', 'Ana Cozinha', 'ana@bar.com');
    await owner.ok('PUT', '/api/settings/pix', PIX);

    expect((await cashier.fail('PUT', '/api/settings/pix', { ...PIX, enabled: false })).status).toBe(403);
    expect(await cashier.ok('GET', '/api/settings/pix')).toMatchObject({ enabled: true, key: '52998224725' });
    expect((await waiter.fail('GET', '/api/settings/pix')).status).toBe(403);
    expect((await kitchen.fail('GET', '/api/settings/pix')).status).toBe(403);

    // Payload: cash.payment ou comandas.view
    expect((await cashier.ok('GET', '/api/pix/payload?amountCents=1000')).payload).toBeTruthy();
    expect((await waiter.ok('GET', '/api/pix/payload?amountCents=1000')).payload).toBeTruthy();
    expect((await kitchen.fail('GET', '/api/pix/payload?amountCents=1000')).status).toBe(403);
    expect((await new Client(env.app).fail('GET', '/api/pix/payload?amountCents=1000')).status).toBe(401);
  });
});

describe('Pix copia e cola', () => {
  it('sem configuração, responde PIX_NOT_CONFIGURED', async () => {
    const r = await owner.fail('GET', '/api/pix/payload?amountCents=1000');
    expect(r).toMatchObject({ status: 409, code: 'PIX_NOT_CONFIGURED' });
    await owner.ok('PUT', '/api/settings/pix', { ...PIX, enabled: false });
    expect((await owner.fail('GET', '/api/pix/payload?amountCents=1000')).code).toBe('PIX_NOT_CONFIGURED');
  });

  it('gera o BR Code do valor com o txid da comanda', async () => {
    await owner.ok('PUT', '/api/settings/pix', PIX);
    const c = await comandaWithItems();
    const r = await owner.ok('GET', `/api/pix/payload?amountCents=${c.remaining}&comandaId=${c.id}`);
    expect(isValidPixPayload(r.payload)).toBe(true);
    expect(r).toMatchObject({ amountCents: 6000, txid: `RB${c.number}`, merchantName: 'Bar da Marina', merchantCity: 'Sao Paulo', keyType: 'cpf', keyLabel: 'CPF' });
    expect(field(r.payload, '54')).toBe('60.00');
    expect(field(r.payload, '59')).toBe('Bar da Marina');
    expect(field(r.payload, '60')).toBe('Sao Paulo');
    expect(parseEmv(field(r.payload, '26')!)).toEqual([{ id: '00', value: 'br.gov.bcb.pix' }, { id: '01', value: '52998224725' }]);
    expect(parseEmv(field(r.payload, '62')!)).toEqual([{ id: '05', value: `RB${c.number}` }]);

    // Sem valor e sem comanda: o cliente digita o valor; txid "***"
    const open = await owner.ok('GET', '/api/pix/payload');
    expect(field(open.payload, '54')).toBeUndefined();
    expect(open.txid).toBe('***');
    expect(isValidPixPayload(open.payload)).toBe(true);
  });

  it('valida valor e comanda', async () => {
    await owner.ok('PUT', '/api/settings/pix', PIX);
    expect((await owner.fail('GET', '/api/pix/payload?amountCents=abc')).code).toBe('VALIDATION');
    expect((await owner.fail('GET', '/api/pix/payload?amountCents=-5')).code).toBe('VALIDATION');
    expect((await owner.fail('GET', '/api/pix/payload?amountCents=10.5')).code).toBe('VALIDATION');
    expect((await owner.fail('GET', '/api/pix/payload?amountCents=100&comandaId=nao-e-uuid')).code).toBe('VALIDATION');
    expect((await owner.fail('GET', `/api/pix/payload?amountCents=100&comandaId=${uuid()}`)).status).toBe(404);
  });
});

describe('conta impressa com Pix', () => {
  it('imprime "Pague com Pix" + QR do saldo; impressora sem QR recebe a chave em texto', async () => {
    const withQr = await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'network', host: '192.168.0.210', printReceipts: true, paper: 80 });
    const noQr = await owner.ok('POST', '/api/printers', { name: 'Caixa antiga', transport: 'network', host: '192.168.0.211', printReceipts: true, paper: 58, printQr: false });
    const printers = await owner.ok('GET', '/api/printers');
    expect(printers.find((p: { id: string }) => p.id === withQr.id).printQr).toBe(true);
    expect(printers.find((p: { id: string }) => p.id === noQr.id).printQr).toBe(false);

    const c = await comandaWithItems();
    // Pix desativado: conta sai como antes
    await owner.ok('POST', `/api/comandas/${c.id}/print`);
    await env.s.printing.processQueue();
    expect(env.printed).toHaveLength(2);
    for (const p of env.printed) {
      expect(Buffer.from(p.bytes).toString('latin1')).not.toContain('Pague com Pix');
      expect(indexOfSeq(p.bytes, GS_K)).toBe(-1);
    }

    await owner.ok('PUT', '/api/settings/pix', PIX);
    env.clock.advance(60_000);
    env.printed.length = 0;
    await owner.ok('POST', `/api/comandas/${c.id}/print`);
    await env.s.printing.processQueue();
    expect(env.printed).toHaveLength(2);
    const expected = (await owner.ok('GET', `/api/pix/payload?amountCents=6000&comandaId=${c.id}`)).payload as string;

    const qr = jobBytes(withQr.id);
    const qrText = Buffer.from(qr).toString('latin1');
    expect(qrText).toContain('Pague com Pix');
    expect(qrText).toContain('R$ 60,00');
    const store = indexOfSeq(qr, [...GS_K, (expected.length + 3) & 0xff, (expected.length + 3) >> 8, 0x31, 0x50, 0x30]);
    expect(store).toBeGreaterThan(0);
    expect(Buffer.from(qr.slice(store + 8, store + 8 + expected.length)).toString('latin1')).toBe(expected);

    const plain = jobBytes(noQr.id);
    const plainText = Buffer.from(plain).toString('latin1');
    expect(plainText).toContain('Pague com Pix');
    expect(plainText).toContain('52998224725');
    expect(indexOfSeq(plain, GS_K)).toBe(-1);

    // Reativar o QR na impressora antiga
    await owner.ok('PUT', `/api/printers/${noQr.id}`, { name: 'Caixa antiga', transport: 'network', host: '192.168.0.211', printReceipts: true, paper: 58, printQr: true });
    expect((await owner.ok('GET', '/api/printers')).every((p: { printQr: boolean }) => p.printQr)).toBe(true);
  });

  it('conta já paga não imprime Pix', async () => {
    await owner.ok('POST', '/api/printers', { name: 'Caixa', transport: 'network', host: '192.168.0.210', printReceipts: true });
    await owner.ok('PUT', '/api/settings/pix', PIX);
    const c = await comandaWithItems();
    await owner.ok('POST', '/api/cash/open', { openingBalanceCents: 0 });
    await owner.ok('POST', '/api/payments', { comandaId: c.id, method: 'pix', amountCents: c.remaining, clientRequestId: uuid() });
    await owner.ok('POST', `/api/comandas/${c.id}/print`);
    await env.s.printing.processQueue();
    expect(Buffer.from(env.printed[0]!.bytes).toString('latin1')).not.toContain('Pague com Pix');
  });
});
