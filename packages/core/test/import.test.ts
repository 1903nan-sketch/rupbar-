import { describe, expect, it } from 'vitest';
import { columnOf, csvRecords, importNameKey, importTemplateCsv, mapImportRecord, parseCsv, parseImportNumber, type ImportRow } from '../src';

const ok = (rec: Record<string, string>): ImportRow => {
  const r = mapImportRecord(rec, 2);
  if (!r.ok) throw new Error(r.error);
  return r.row;
};
const error = (rec: Record<string, string>): string => {
  const r = mapImportRecord(rec, 2);
  if (r.ok) throw new Error('esperava erro');
  return r.error;
};

describe('leitura da planilha', () => {
  it('lê o CSV do Excel brasileiro (;) com aspas, BOM e linhas em branco', () => {
    const text = '﻿nome;custo\r\n"Gin ""Rocks""; 1 L";"90,00"\r\n;\r\nÁgua;2\n';
    expect(parseCsv(text)).toEqual([['nome', 'custo'], ['Gin "Rocks"; 1 L', '90,00'], ['Água', '2']]);
  });

  it('aceita vírgula e tabulação como separador', () => {
    expect(parseCsv('nome,preco\nCoca,"6,00"')).toEqual([['nome', 'preco'], ['Coca', '6,00']]);
    expect(parseCsv('nome\tpreco\nCoca\t6,00')).toEqual([['nome', 'preco'], ['Coca', '6,00']]);
  });

  it('reconhece cabeçalhos escritos à mão e ignora colunas desconhecidas', () => {
    expect(columnOf('Produto')).toBe('nome');
    expect(columnOf('Preço de venda')).toBe('preco_venda');
    expect(columnOf('Código de barras')).toBe('codigo_barras');
    expect(columnOf('Estoque Soltas')).toBe('estoque_soltas');
    const { records, columns, unknown } = csvRecords('Produto;Fechados;Observação\nHeineken;3;geladeira\n');
    expect(columns).toEqual(['nome', 'estoque_embalagens']);
    expect(unknown).toEqual(['Observação']);
    expect(records).toEqual([{ nome: 'Heineken', estoque_embalagens: '3' }]);
  });

  it('entende números no padrão brasileiro', () => {
    expect(parseImportNumber('1.234,56')).toBe(1234.56);
    expect(parseImportNumber('R$ 12,00')).toBe(12);
    expect(parseImportNumber('1.000')).toBe(1000);
    expect(parseImportNumber('12.5')).toBe(12.5);
    expect(parseImportNumber('')).toBeNull();
    expect(parseImportNumber('doze')).toBeNaN();
  });

  it('acha o mesmo nome sem acento, maiúsculas ou espaços a mais', () => {
    expect(importNameKey('  Água  Mineral ')).toBe(importNameKey('agua mineral'));
  });

  it('o modelo traz o cabeçalho e exemplos que importam sem erro', () => {
    const { records } = csvRecords(importTemplateCsv());
    expect(records.length).toBeGreaterThan(3);
    records.forEach((r, i) => expect(mapImportRecord(r, i + 2).ok).toBe(true));
  });
});

describe('linha da planilha → produto', () => {
  it('fardo: saldo = fardos fechados + unidades soltas, preço por unidade e mínimo em unidades', () => {
    const r = ok({
      nome: 'Heineken long neck', categoria: 'Cervejas', como_compra: 'fardo', qtd_embalagem: '24', nome_unidade: 'long neck',
      estoque_embalagens: '3', estoque_soltas: '5', custo_embalagem: '120,00', preco_venda: '12,00', estoque_minimo: '24', codigo_barras: '7896045506873',
    });
    expect(r).toMatchObject({
      measure: 'unit', packageQty: 24_000, packageLabel: 'fardo', unitLabel: 'long neck', stockQty: 77_000, packageCostCents: 12_000,
      minStock: 24_000, barcode: '7896045506873', presentations: [{ name: 'Unidade', priceCents: 1200, qty: 1000 }], warnings: [],
    });
  });

  it('garrafa: dose em ml e garrafa fechada, saldo com a garrafa aberta em ml', () => {
    const r = ok({
      nome: 'Gin Rocks 1 L', como_compra: 'garrafa', qtd_embalagem: '1 L', estoque_embalagens: '2', estoque_soltas: '500',
      preco_venda: '12', dose_ml: '50', preco_garrafa: '120', estoque_minimo: '1',
    });
    expect(r.measure).toBe('volume');
    expect(r.packageQty).toBe(1_000_000);
    expect(r.stockQty).toBe(2_500_000);
    expect(r.minStock).toBe(1_000_000);
    expect(r.presentations).toEqual([
      { name: 'Dose 50 ml', priceCents: 1200, qty: 50_000 },
      { name: 'Garrafa fechada', priceCents: 12_000, qty: 1_000_000 },
    ]);
  });

  it('pacote sem dose vende o pacote fechado; sem preço vira ingrediente', () => {
    expect(ok({ nome: 'Ziggy Menta', como_compra: 'pacote', qtd_embalagem: '50 g', estoque_embalagens: '6', preco_venda: '45' }).presentations)
      .toEqual([{ name: 'Pacote fechado', priceCents: 4500, qty: 50_000 }]);
    const gelo = ok({ nome: 'Gelo de coco', estoque_soltas: '40', custo_embalagem: '1,50' });
    expect(gelo).toMatchObject({ buy: 'unidade', measure: 'unit', packageQty: 1000, stockQty: 40_000, presentations: [] });
    expect(gelo.warnings.join(' ')).toMatch(/ingrediente/);
  });

  it('sem nenhuma quantidade o saldo não muda', () => {
    const r = ok({ nome: 'Coca lata', preco_venda: '6' });
    expect(r.stockQty).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/saldo não muda/);
  });

  it('explica o que corrigir quando a linha está errada', () => {
    expect(error({ nome: 'X' })).toMatch(/nome/);
    expect(error({ nome: 'Heineken', como_compra: 'barril' })).toMatch(/unidade, fardo, garrafa ou pacote/);
    expect(error({ nome: 'Heineken', como_compra: 'fardo' })).toMatch(/quantas unidades/);
    expect(error({ nome: 'Gin', como_compra: 'garrafa' })).toMatch(/tamanho da garrafa/);
    expect(error({ nome: 'Gin', como_compra: 'garrafa', qtd_embalagem: '1000', dose_ml: '2000', preco_venda: '10' })).toMatch(/maior que a embalagem/);
    expect(error({ nome: 'Coca', estoque_soltas: 'dez' })).toMatch(/Estoque inválido/);
    expect(error({ nome: 'Coca', preco_venda: 'seis' })).toMatch(/Preço de venda inválido/);
    expect(error({ nome: 'Coca', codigo_barras: '78#9' })).toMatch(/Código de barras inválido/);
  });
});
