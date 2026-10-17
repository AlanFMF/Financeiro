import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupAi, scriptedProvider, tool, say, lastResult, TODAY } from './ai-helpers.js';
import { parseBudgetQuestion } from '../src/assistant/rules.js';
import { daysLeft, levelOf } from '../src/lib/budgets.js';

const MONTH = TODAY.slice(0, 7);

type Ctx = Awaited<ReturnType<typeof setupAi>>;
let ctx: Ctx;

async function categoryId(name: string) {
  const cats = (await ctx.app.inject({ method: 'GET', url: '/api/categories', headers: ctx.headers })).json().categories;
  return cats.find((c: { name: string }) => c.name === name).id as number;
}
const setBudget = async (name: string, budgetCents: number | null) =>
  ctx.app.inject({ method: 'PUT', url: `/api/budgets/${await categoryId(name)}`, headers: ctx.headers, payload: { budgetCents } });
const spend = async (name: string, amountCents: number, date = TODAY) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/transactions',
    headers: ctx.headers,
    payload: { categoryId: await categoryId(name), date, description: 'Teste', amountCents }
  });
const budgets = async () =>
  (await ctx.app.inject({ method: 'GET', url: `/api/budgets?month=${MONTH}`, headers: ctx.headers })).json().budgets;
const alerts = async () =>
  (await ctx.app.inject({ method: 'POST', url: '/api/budgets/alerts', headers: ctx.headers, payload: { month: MONTH } })).json().alerts;

describe('metas por categoria', () => {
  beforeEach(async () => {
    ctx = await setupAi();
  });
  afterEach(() => ctx.close());

  it('define, mostra o andamento e remove a meta', async () => {
    expect((await setBudget('Alimentação', 800_00)).statusCode).toBe(200);
    await spend('Alimentação', 300_00);
    await spend('Alimentação', 100_00, '2026-09-30'); // mês passado não conta
    const [b] = await budgets();
    expect(b).toMatchObject({ name: 'Alimentação', budgetCents: 800_00, spentCents: 300_00, remainingCents: 500_00, pct: 37, level: 0 });

    const cats = (await ctx.app.inject({ method: 'GET', url: '/api/categories', headers: ctx.headers })).json().categories;
    expect(cats.find((c: { name: string }) => c.name === 'Alimentação').budgetCents).toBe(800_00);

    await setBudget('Alimentação', null);
    expect(await budgets()).toEqual([]);
  });

  it('só aceita meta em categoria de saída e da própria conta', async () => {
    expect((await setBudget('Pró-labore/Salário', 1000_00)).statusCode).toBe(400);
    expect((await setBudget('Alimentação', 0)).statusCode).toBe(400);
    const other = await ctx.register('outro@x.com');
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/budgets/${await categoryId('Alimentação')}`,
      headers: other,
      payload: { budgetCents: 100_00 }
    });
    expect(res.statusCode).toBe(404);
  });

  it('avisa uma vez ao chegar a 80% e outra ao atingir a meta', async () => {
    await setBudget('Alimentação', 800_00);
    await spend('Alimentação', 600_00); // 75%
    expect(await alerts()).toEqual([]);

    await spend('Alimentação', 40_00); // 80%
    const first = await alerts();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ level: 80, pct: 80 });
    expect(first[0].message.replace(/\s/g, ' ')).toBe('Você já usou 80% da meta de Alimentação: R$ 640,00 de R$ 800,00. Restam R$ 160,00.');
    expect(await alerts()).toEqual([]); // não repete

    await spend('Alimentação', 200_00); // 105%
    const second = await alerts();
    expect(second.map((a: { level: number }) => a.level)).toEqual([100]);
    expect(second[0].message.replace(/\s/g, ' ')).toBe('Você passou da meta de Alimentação: R$ 840,00 de R$ 800,00 (R$ 40,00 acima).');
    expect(await alerts()).toEqual([]);
  });

  it('pulando direto para 100% avisa só uma vez', async () => {
    await setBudget('Lazer', 200_00);
    await spend('Lazer', 250_00);
    expect((await alerts()).map((a: { level: number }) => a.level)).toEqual([100]);
    expect(await alerts()).toEqual([]);
  });

  it('mudar a meta recomeça os avisos', async () => {
    await setBudget('Lazer', 200_00);
    await spend('Lazer', 170_00);
    expect(await alerts()).toHaveLength(1);
    await setBudget('Lazer', 210_00); // 80,9%: avisa de novo com o novo limite
    expect((await alerts())[0].level).toBe(80);
  });

  it('o chat devolve o aviso junto com o lançamento (modo simples)', async () => {
    await setBudget('Alimentação', 100_00);
    const body = (await ctx.chat('gastei 85 no mercado')).json();
    expect(body.transactions).toHaveLength(1);
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({ level: 80 });
    expect(body.alerts[0].message).toContain('85% da meta de Alimentação');
    expect(await alerts()).toEqual([]); // já foi dado no chat
  });

  it('responde "quanto ainda posso gastar" sem IA', async () => {
    await setBudget('Alimentação', 800_00);
    await spend('Alimentação', 300_00);
    const body = (await ctx.chat('quanto ainda posso gastar no mercado?')).json();
    expect(body.transactions).toEqual([]);
    // 16/10: faltam 16 dias contando hoje → R$ 500 / 16 = R$ 31,25 por dia
    expect(body.reply.replace(/\s/g, ' ')).toBe(
      'Alimentação: ainda pode gastar R$ 500,00 (gastou R$ 300,00 de R$ 800,00, 37%). Dá R$ 31,25 por dia até o fim do mês.'
    );

    const none = (await ctx.chat('quanto ainda posso gastar com lazer?')).json();
    expect(none.reply).toContain('ainda não tem meta');
  });
});

describe('metas pela IA', () => {
  it('define a meta e consulta o que resta', async () => {
    const fake = scriptedProvider([
      () => tool('definir_meta', { categoria: 'mercado', valor: 800 }),
      (rec) => say(lastResult(rec)),
      () => tool('consultar_metas', { categoria: 'alimentação' }),
      (rec) => say(lastResult(rec))
    ]);
    ctx = await setupAi(fake.factory);
    const set = (await ctx.chat('quero gastar no máximo 800 com mercado')).json();
    expect(set.reply.replace(/\s/g, ' ')).toContain('Meta de Alimentação definida em R$ 800,00 por mês.');
    expect((await budgets())[0]).toMatchObject({ budgetCents: 800_00 });

    await spend('Alimentação', 700_00);
    const ask = (await ctx.chat('quanto ainda posso gastar no mercado?')).json();
    expect(ask.reply.replace(/\s/g, ' ')).toContain('ainda pode gastar R$ 100,00');
    await ctx.close();
  });
});

describe('regras de metas', () => {
  it.each([
    ['quanto ainda posso gastar no mercado?', 'mercado'],
    ['Quanto posso gastar em lazer esse mês', 'lazer'],
    ['quanto me resta pra gastar com transporte', 'transporte'],
    ['quanto falta pra meta de alimentação?', 'alimentacao'],
    ['como estão minhas metas?', ''],
    ['metas', '']
  ])('"%s"', (msg, category) => {
    expect(parseBudgetQuestion(msg)).toEqual({ category });
  });

  it.each(['gastei 50 no mercado', 'quanto gastei com mercado?', 'oi'])('não é pergunta de meta: "%s"', (msg) => {
    expect(parseBudgetQuestion(msg)).toBeNull();
  });

  it('faixas e dias restantes', () => {
    expect(levelOf(79_99, 100_00)).toBe(0);
    expect(levelOf(80_00, 100_00)).toBe(80);
    expect(levelOf(100_00, 100_00)).toBe(100);
    expect(daysLeft('2026-10', '2026-10-16')).toBe(16);
    expect(daysLeft('2026-10', '2026-10-31')).toBe(1);
    expect(daysLeft('2026-09', '2026-10-16')).toBe(0);
  });
});
