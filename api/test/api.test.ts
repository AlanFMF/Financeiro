import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.close();
});

describe('autenticação', () => {
  it('cadastra, entra e lê o próprio perfil', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Ana', email: 'ANA@exemplo.com', password: '12345678' }
    });
    expect(reg.statusCode).toBe(201);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ana@exemplo.com', password: '12345678' }
    });
    expect(login.statusCode).toBe(200);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${login.json().token}` }
    });
    expect(me.json().user).toMatchObject({ name: 'Ana', email: 'ana@exemplo.com', isDemo: false });
  });

  it('recusa senha errada e e-mail repetido', async () => {
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@exemplo.com', password: 'x' } });
    expect(bad.statusCode).toBe(401);
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Ana', email: 'ana@exemplo.com', password: '12345678' }
    });
    expect(dup.statusCode).toBe(409);
  });

  it('bloqueia rota protegida sem token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/transactions' });
    expect(res.statusCode).toBe(401);
  });

  it('valida campos do cadastro', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: '', email: 'x', password: '1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { path: string }) => i.path)).toEqual(['name', 'email', 'password']);
  });
});

describe('lançamentos e resumo', () => {
  it('cria lançamentos e calcula o resumo do mês', async () => {
    const { headers, cat } = await ctx.register('resumo@exemplo.com');
    const add = (categoryId: number, date: string, amountCents: number, description = '', isFixed = false) =>
      ctx.app.inject({ method: 'POST', url: '/api/transactions', headers, payload: { categoryId, date, amountCents, description, isFixed } });

    expect((await add(cat('Pró-labore/Salário'), '2026-10-05', 420000)).statusCode).toBe(201);
    await add(cat('Moradia'), '2026-10-10', 120000, 'Aluguel', true);
    await add(cat('Alimentação'), '2026-10-12', 35050, 'Mercado');
    await add(cat('Alimentação'), '2026-09-12', 10000, 'Mês anterior');

    const s = (await ctx.app.inject({ method: 'GET', url: '/api/summary?month=2026-10', headers })).json();
    expect(s).toMatchObject({ income: 420000, expense: 155050, balance: 264950, fixedExpense: 120000 });
    expect(s.previous.expense).toBe(10000);
    expect(s.byCategory.find((c: { name: string }) => c.name === 'Alimentação').total).toBe(35050);

    const list = (await ctx.app.inject({ method: 'GET', url: '/api/transactions?month=2026-10&q=merc', headers })).json();
    expect(list.transactions).toHaveLength(1);

    const hist = (await ctx.app.inject({ method: 'GET', url: '/api/summary/history?month=2026-10&months=3', headers })).json();
    expect(hist.series.map((p: { month: string; expense: number }) => [p.month, p.expense])).toEqual([
      ['2026-08', 0],
      ['2026-09', 10000],
      ['2026-10', 155050]
    ]);
  });

  it('não deixa um usuário ver ou mexer nos dados de outro', async () => {
    const a = await ctx.register('a@exemplo.com');
    const b = await ctx.register('b@exemplo.com');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: a.headers,
      payload: { categoryId: a.cat('Lazer'), date: '2026-10-01', amountCents: 5000 }
    });
    const id = created.json().transaction.id;

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/transactions/${id}`, headers: b.headers });
    expect(del.statusCode).toBe(404);

    const useOtherCategory = await ctx.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: b.headers,
      payload: { categoryId: a.cat('Lazer'), date: '2026-10-01', amountCents: 5000 }
    });
    expect(useOtherCategory.statusCode).toBe(400);

    const listB = (await ctx.app.inject({ method: 'GET', url: '/api/transactions', headers: b.headers })).json();
    expect(listB.transactions).toHaveLength(0);
  });

  it('copia fixos para o mês seguinte avançando parcelas, sem duplicar', async () => {
    const { headers, cat } = await ctx.register('fixos@exemplo.com');
    const add = (categoryId: number, date: string, description: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers,
        payload: { categoryId, date, description, amountCents: 122776, isFixed: true }
      });
    await add(cat('Transporte'), '2027-01-31', 'Financiamento Carro (11/48)');
    await add(cat('Transporte'), '2027-01-10', 'Seguro (12/12)');

    const copy = () => ctx.app.inject({ method: 'POST', url: '/api/transactions/copy-fixed', headers, payload: { from: '2027-01', to: '2027-02' } });
    expect((await copy()).json()).toEqual({ created: 1, skipped: 0, finished: 1 });
    expect((await copy()).json()).toEqual({ created: 0, skipped: 1, finished: 1 });

    const feb = (await ctx.app.inject({ method: 'GET', url: '/api/transactions?month=2027-02', headers })).json().transactions;
    expect(feb).toHaveLength(1);
    expect(feb[0]).toMatchObject({ description: 'Financiamento Carro (12/48)', date: '2027-02-28' });
  });
});

describe('categorias', () => {
  it('cria, renomeia e só exclui quando não tem lançamentos', async () => {
    const { headers, cat } = await ctx.register('cat@exemplo.com');
    const created = await ctx.app.inject({ method: 'POST', url: '/api/categories', headers, payload: { name: 'Viagens', kind: 'saida', color: '#336699' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().category.id;

    const renamed = await ctx.app.inject({ method: 'PATCH', url: `/api/categories/${id}`, headers, payload: { name: 'Viagem' } });
    expect(renamed.json().category.name).toBe('Viagem');

    await ctx.app.inject({ method: 'POST', url: '/api/transactions', headers, payload: { categoryId: cat('Pet'), date: '2026-10-01', amountCents: 100 } });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/categories/${cat('Pet')}`, headers })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/categories/${id}`, headers })).statusCode).toBe(204);
  });
});

describe('importação e exportação', () => {
  const csv = [
    'Data,Categoria,Descrição,Entrada (R$),Saída (R$)',
    '05/10/2026,Pró-labore/Salário,Salário,4200.00,',
    '10/10/2026,Moradia,Condomínio,,150.00',
    '11/10/2026,Viagens,Passagem,,480.00',
    '99/99/2026,Lazer,Data quebrada,,10'
  ].join('\n');

  it('mostra prévia sem gravar e depois importa sem duplicar', async () => {
    const { headers } = await ctx.register('import@exemplo.com');
    const send = (dryRun: boolean) => ctx.app.inject({ method: 'POST', url: '/api/import/csv', headers, payload: { csv, dryRun } });

    const preview = (await send(true)).json();
    expect(preview.rows).toHaveLength(3);
    expect(preview.errors).toHaveLength(1);
    expect(preview.newCategories).toEqual([{ name: 'Viagens', kind: 'saida' }]);
    expect(preview.totals).toEqual({ income: 420000, expense: 63000 });

    const empty = (await ctx.app.inject({ method: 'GET', url: '/api/transactions', headers })).json();
    expect(empty.transactions).toHaveLength(0);

    expect((await send(false)).json()).toMatchObject({ created: 3, duplicates: 0 });
    expect((await send(false)).json()).toMatchObject({ created: 0, duplicates: 3 });

    const exported = await ctx.app.inject({ method: 'GET', url: '/api/export.csv?year=2026', headers });
    expect(exported.headers['content-type']).toContain('text/csv');
    const lines = exported.body.replace('﻿', '').trim().split('\n');
    expect(lines[0]).toBe('Data,Categoria,Descrição,Entrada (R$),Saída (R$)');
    expect(lines[2]).toBe('10/10/2026,Moradia,Condomínio,,150.00');
  });
});

describe('demonstração', () => {
  it('cria uma conta demo com dados fictícios', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/demo' });
    const { token, user } = res.json();
    expect(user.isDemo).toBe(true);
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/transactions', headers: { authorization: `Bearer ${token}` } })).json();
    expect(list.transactions.length).toBeGreaterThan(40);
  });
});
