import { describe, expect, it } from 'vitest';
import { nextInstallment, parseMoneyToCents, shiftMonth, daysInMonth } from '../src/lib/money.js';
import { parseCsv, parseDate, parseTransactionsCsv } from '../src/lib/csv.js';

describe('parseMoneyToCents', () => {
  it.each([
    ['1227.76', 122776],
    ['1.227,76', 122776],
    ['1,227.76', 122776],
    ['R$ 150,00', 15000],
    ['1.500', 150000],
    ['19.9', 1990],
    ['-45,90', -4590],
    ['(30,00)', -3000],
    ['-', 0],
    ['', 0]
  ])('%s → %i', (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });

  it('retorna null para texto que não é número', () => {
    expect(parseMoneyToCents('abc')).toBeNull();
  });
});

describe('datas e meses', () => {
  it('aceita dd/mm/aaaa, dd/mm/aa e ISO', () => {
    expect(parseDate('10/09/2026')).toBe('2026-09-10');
    expect(parseDate('5/1/26')).toBe('2026-01-05');
    expect(parseDate('2026-02-28')).toBe('2026-02-28');
    expect(parseDate('15/10', 2026)).toBe('2026-10-15');
  });

  it('rejeita data inexistente', () => {
    expect(parseDate('31/02/2026')).toBeNull();
  });

  it('desloca meses atravessando o ano', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(daysInMonth('2028-02')).toBe(29);
  });
});

describe('nextInstallment', () => {
  it('avança a parcela', () => {
    expect(nextInstallment('Financiamento Carro (10/48)')).toBe('Financiamento Carro (11/48)');
  });
  it('encerra na última parcela', () => {
    expect(nextInstallment('Financiamento (48/48)')).toBeNull();
  });
  it('mantém descrição sem parcela', () => {
    expect(nextInstallment('Aluguel')).toBe('Aluguel');
  });
});

describe('parseCsv', () => {
  it('lida com aspas, vírgula dentro de campo e ponto e vírgula', () => {
    expect(parseCsv('a;"b;c";"d ""e"""\n1;2;3')).toEqual([
      ['a', 'b;c', 'd "e"'],
      ['1', '2', '3']
    ]);
  });
});

describe('parseTransactionsCsv', () => {
  it('lê uma aba da planilha com linhas de título e total', () => {
    const csv = [
      'Outubro 2026,,,,',
      'Data,Categoria,Descrição,Entrada (R$),Saída (R$)',
      '05/10/2026,Pró-labore/Salário,Salário,4200.00,-',
      '10/10/2026,Moradia,Condomínio,,150.00',
      '10/10/2026,Transporte,"Financiamento Carro Alan (10/48)",,1227.76',
      ',,Total,4200.00,1377.76'
    ].join('\n');
    const { rows, errors } = parseTransactionsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ date: '2026-10-05', kind: 'entrada', amountCents: 420000 });
    expect(rows[2]).toMatchObject({ category: 'Transporte', kind: 'saida', amountCents: 122776 });
  });

  it('lê extrato com coluna Valor com sinal', () => {
    const { rows } = parseTransactionsCsv('Data;Descrição;Valor\n01/10/2026;Pix recebido;350,00\n02/10/2026;Mercado;-89,90');
    expect(rows.map((r) => [r.kind, r.amountCents, r.category])).toEqual([
      ['entrada', 35000, 'Outras receitas'],
      ['saida', 8990, 'Imprevistos/Outros']
    ]);
  });

  it('aponta a linha com erro', () => {
    const { errors } = parseTransactionsCsv('Data,Categoria,Entrada,Saída\n32/13/2026,Lazer,,10');
    expect(errors[0]).toMatchObject({ line: 2 });
  });
});
