import { describe, expect, it } from 'vitest';
import {
  buildPixPayload, crc16Ccitt, emvField, formatPixAmount, isValidPixPayload, normalizePixKey, parseEmv, sanitizePixText, sanitizeTxid,
} from '../src';

/** Exemplo oficial do Manual de Padrões para Iniciação do Pix (BCB). */
const BCB_EXAMPLE =
  '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

const field = (payload: string, id: string) => parseEmv(payload).find((f) => f.id === id)?.value;

describe('CRC16/CCITT-FALSE', () => {
  it('confere o valor de verificação padrão do algoritmo', () => {
    // Valor de referência do CRC-16/CCITT-FALSE para "123456789".
    expect(crc16Ccitt('123456789')).toBe('29B1');
    expect(crc16Ccitt('')).toBe('FFFF');
  });
  it('é calculado sobre todo o conteúdo, incluindo "6304"', () => {
    expect(crc16Ccitt(BCB_EXAMPLE.slice(0, -4))).toBe('1D3D');
  });
  it('sempre tem 4 dígitos hexadecimais maiúsculos (com zeros à esquerda)', () => {
    for (const s of ['A', 'pix', '0002010102', 'Bar da Marina']) expect(crc16Ccitt(s)).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('BR Code (Pix copia e cola estático)', () => {
  it('reproduz o exemplo oficial do Banco Central', () => {
    const p = buildPixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', merchantName: 'Fulano de Tal', merchantCity: 'BRASILIA', txid: '***' });
    expect(p).toBe(BCB_EXAMPLE);
    expect(isValidPixPayload(p)).toBe(true);
    // Sem txid informado, o padrão é "***"
    expect(buildPixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', merchantName: 'Fulano de Tal', merchantCity: 'BRASILIA' })).toBe(BCB_EXAMPLE);
  });

  it('inclui valor e txid na ordem e com tamanhos corretos', () => {
    const p = buildPixPayload({ key: '12345678909', merchantName: 'Bar da Marina', merchantCity: 'São Paulo', amountCents: 4590, txid: 'RB-123' });
    // CRC conferido de forma independente (binascii.crc_hqx com valor inicial 0xFFFF).
    expect(p).toBe(
      '00020126330014br.gov.bcb.pix0111123456789095204000053039865405' +
        '45.905802BR5913Bar da Marina6009Sao Paulo62090505RB123' + '6304FC08',
    );
    expect(parseEmv(p).map((f) => f.id)).toEqual(['00', '26', '52', '53', '54', '58', '59', '60', '62', '63']);
    expect(field(p, '54')).toBe('45.90');
    expect(parseEmv(field(p, '62')!)).toEqual([{ id: '05', value: 'RB123' }]);
    expect(isValidPixPayload(p)).toBe(true);
  });

  it('omite o valor quando é zero e formata centavos sem ponto flutuante', () => {
    const p = buildPixPayload({ key: '12345678909', merchantName: 'Bar', merchantCity: 'Rio', amountCents: 0 });
    expect(field(p, '54')).toBeUndefined();
    expect(formatPixAmount(1)).toBe('0.01');
    expect(formatPixAmount(10)).toBe('0.10');
    expect(formatPixAmount(123456)).toBe('1234.56');
    expect(formatPixAmount(1_000_000_00)).toBe('1000000.00');
    expect(() => formatPixAmount(-1)).toThrow();
    expect(() => formatPixAmount(1.5)).toThrow();
  });

  it('normaliza nome e cidade: remove acentos e símbolos, mantém caixa e trunca', () => {
    expect(sanitizePixText('  Açaí & Cia — Botequim do João!!  ', 25)).toBe('Acai & Cia Botequim do Jo');
    expect(sanitizePixText('São José dos Campos', 15)).toBe('Sao Jose dos Ca');
    expect(sanitizePixText('Bar   do   Zé', 25)).toBe('Bar do Ze');
    expect(sanitizePixText('🍺🍺', 25)).toBe('');
    const p = buildPixPayload({ key: '12345678909', merchantName: 'Choperia Cervejaria Artesanal Ltda', merchantCity: 'Florianópolis do Sul', amountCents: 100 });
    expect(field(p, '59')).toBe('Choperia Cervejaria Artes');
    expect(field(p, '59')).toHaveLength(25);
    expect(field(p, '60')).toBe('Florianopolis d');
    expect(field(p, '60')).toHaveLength(15);
  });

  it('txid: até 25 alfanuméricos; vazio vira "***"', () => {
    expect(sanitizeTxid('RB 1.234')).toBe('RB1234');
    expect(sanitizeTxid('')).toBe('***');
    expect(sanitizeTxid(null)).toBe('***');
    expect(sanitizeTxid('x'.repeat(40))).toHaveLength(25);
  });

  it('prefixos de tamanho corretos para campos longos (e-mail de 77 caracteres)', () => {
    const email = `${'a'.repeat(64)}@exemplo.com.b`.slice(0, 77);
    expect(email).toHaveLength(77);
    const p = buildPixPayload({ key: email, merchantName: 'N'.repeat(40), merchantCity: 'C'.repeat(40), txid: 'T'.repeat(30), description: 'não cabe' });
    const account = field(p, '26')!;
    expect(account).toHaveLength(99);
    expect(p).toContain('2699' + '0014br.gov.bcb.pix' + '0177' + email);
    // Sem espaço para a descrição: o campo 02 não entra
    expect(parseEmv(account).map((f) => f.id)).toEqual(['00', '01']);
    expect(p).toContain('5925' + 'N'.repeat(25));
    expect(p).toContain('6015' + 'C'.repeat(15));
    expect(p).toContain('62290525' + 'T'.repeat(25));
    expect(isValidPixPayload(p)).toBe(true);
  });

  it('inclui a descrição quando cabe', () => {
    const p = buildPixPayload({ key: '12345678909', merchantName: 'Bar', merchantCity: 'Rio', description: 'Comanda 12' });
    expect(parseEmv(field(p, '26')!)).toEqual([
      { id: '00', value: 'br.gov.bcb.pix' },
      { id: '01', value: '12345678909' },
      { id: '02', value: 'Comanda 12' },
    ]);
  });

  it('emvField rejeita valores com mais de 99 caracteres', () => {
    expect(emvField('59', 'abc')).toBe('5903abc');
    expect(() => emvField('26', 'x'.repeat(100))).toThrow();
  });

  it('exige chave, nome e cidade', () => {
    expect(() => buildPixPayload({ key: '', merchantName: 'Bar', merchantCity: 'Rio' })).toThrow();
    expect(() => buildPixPayload({ key: '12345678909', merchantName: '!!!', merchantCity: 'Rio' })).toThrow();
    expect(() => buildPixPayload({ key: '12345678909', merchantName: 'Bar', merchantCity: '' })).toThrow();
  });

  it('detecta payload adulterado', () => {
    expect(isValidPixPayload(BCB_EXAMPLE)).toBe(true);
    expect(isValidPixPayload(BCB_EXAMPLE.replace('Fulano', 'Ciclano'))).toBe(false);
    expect(isValidPixPayload(BCB_EXAMPLE.slice(0, -1))).toBe(false);
    expect(isValidPixPayload('qualquer coisa')).toBe(false);
  });
});

describe('chaves Pix', () => {
  it('CPF e CNPJ: só dígitos, com dígitos verificadores válidos', () => {
    expect(normalizePixKey('cpf', '529.982.247-25')).toEqual({ ok: true, key: '52998224725' });
    expect(normalizePixKey('cpf', '529.982.247-26').ok).toBe(false);
    expect(normalizePixKey('cpf', '111.111.111-11').ok).toBe(false);
    expect(normalizePixKey('cnpj', '11.222.333/0001-81')).toEqual({ ok: true, key: '11222333000181' });
    expect(normalizePixKey('cnpj', '11.222.333/0001-82').ok).toBe(false);
    expect(normalizePixKey('cpf', '11.222.333/0001-81').ok).toBe(false);
  });
  it('celular no formato +55DDDNÚMERO', () => {
    expect(normalizePixKey('phone', '(11) 98765-4321')).toEqual({ ok: true, key: '+5511987654321' });
    expect(normalizePixKey('phone', '+55 11 98765-4321')).toEqual({ ok: true, key: '+5511987654321' });
    expect(normalizePixKey('phone', '(11) 3333-4444').ok).toBe(false); // fixo não é chave Pix
    expect(normalizePixKey('phone', '98765-4321').ok).toBe(false);
  });
  it('e-mail em minúsculas', () => {
    expect(normalizePixKey('email', '  Contato@BarDaMarina.com.br ')).toEqual({ ok: true, key: 'contato@bardamarina.com.br' });
    expect(normalizePixKey('email', 'sem-arroba').ok).toBe(false);
    expect(normalizePixKey('email', 'joão@bar.com').ok).toBe(false);
  });
  it('chave aleatória (EVP) como UUID minúsculo', () => {
    expect(normalizePixKey('random', '123E4567-E12B-12D1-A456-426655440000')).toEqual({ ok: true, key: '123e4567-e12b-12d1-a456-426655440000' });
    expect(normalizePixKey('random', '123e4567e12b12d1a456426655440000')).toEqual({ ok: true, key: '123e4567-e12b-12d1-a456-426655440000' });
    expect(normalizePixKey('random', '123e4567-e12b-12d1-a456').ok).toBe(false);
    expect(normalizePixKey('random', '').ok).toBe(false);
  });
});
