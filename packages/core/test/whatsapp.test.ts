import { describe, expect, it } from 'vitest';
import { evolutionStatus, normalizeEvolutionUrl, phoneToWhatsApp, WA_CONNECTION_STATUS } from '../src';
import { evolutionCredentialsSchema, whatsappSchema } from '../src/schemas';

describe('WhatsApp / Evolution API', () => {
  it('número no formato do WhatsApp: 55 + DDD + número', () => {
    expect(phoneToWhatsApp('(11) 98765-4321')).toBe('5511987654321');
    expect(phoneToWhatsApp('+55 21 3333-4444')).toBe('552133334444');
    expect(phoneToWhatsApp('5511987654321')).toBe('5511987654321');
    expect(phoneToWhatsApp('98765-4321')).toBeNull();
  });

  it('estado da conexão para o proprietário', () => {
    expect(evolutionStatus('open')).toBe('connected');
    expect(evolutionStatus('connecting')).toBe('waiting_qr');
    expect(evolutionStatus('close')).toBe('disconnected');
    expect(evolutionStatus(undefined)).toBe('disconnected');
    expect(WA_CONNECTION_STATUS.waiting_qr).toBe('Aguardando QR');
  });

  it('endereço colado de qualquer jeito vira a URL base da API', () => {
    expect(normalizeEvolutionUrl('https://evo.example.com/')).toBe('https://evo.example.com');
    expect(normalizeEvolutionUrl(' evo.example.com/manager/instance ')).toBe('https://evo.example.com');
    expect(normalizeEvolutionUrl('192.168.0.20:8080')).toBe('http://192.168.0.20:8080');
    expect(normalizeEvolutionUrl('http://localhost:8080//')).toBe('http://localhost:8080');
    expect(normalizeEvolutionUrl('https://api.bar.com.br/evolution/?x=1')).toBe('https://api.bar.com.br/evolution');
    expect(normalizeEvolutionUrl('')).toBe('');
  });

  it('esquema: campos em branco mantêm o valor salvo; instância sem espaços', () => {
    expect(evolutionCredentialsSchema.parse({ baseUrl: '', apiKey: '  ', instance: '' })).toEqual({});
    expect(evolutionCredentialsSchema.parse({ baseUrl: 'evo.example.com', apiKey: ' abc​123 ', instance: 'rupbar' })).toEqual({
      baseUrl: 'https://evo.example.com', apiKey: 'abc123', instance: 'rupbar',
    });
    expect(evolutionCredentialsSchema.safeParse({ instance: 'meu bar' }).success).toBe(false);
    expect(evolutionCredentialsSchema.safeParse({ baseUrl: 'ftp://evo.example.com' }).success).toBe(false);
    const cfg = whatsappSchema.parse({ provider: 'evolution', ownerPhone: '(11) 97777-6666', alerts: { cashClosed: true } });
    expect(cfg).toMatchObject({ provider: 'evolution', ownerPhone: '11977776666', alerts: { cashClosed: true } });
  });
});
