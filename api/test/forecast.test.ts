import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { monthForecast, forecastMessage } from '../src/lib/forecast.js';
import { isForecastQuestion } from '../src/assistant/rules.js';
import { setupAi } from './ai-helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let user: Awaited<ReturnType<typeof ctx.register>>;
let userId: number;

beforeEach(async () => {
  ctx = await setup();
  user = await ctx.register('prev@x.com');
  userId = (await ctx.db.query<{ id: number }>("select id from users where email = 'prev@x.com'")).rows[0].id;
});
afterEach(() => ctx.close());

const add = (cat: string, date: string, amountCents: number, description = '', isFixed = false) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/transactions',
    headers: user.headers,
    payload: { categoryId: user.cat(cat), date, description, amountCents, isFixed }
  });

describe('previsão do fim do mês', () => {
  it('soma os fixos que faltam e o ritmo do dia a dia', async () => {
    // Setembro: salário e aluguel fixos, parcela 3/10, 900 de mercado no mês (30 por dia).
    await add('Pró-labore/Salário', '2026-09-05', 4000_00, 'Salário', true);
    await add('Moradia', '2026-09-10', 1200_00, 'Aluguel', true);
    await add('Transporte', '2026-09-12', 300_00, 'Moto (3/10)', true);
    await add('Contas', '2026-09-15', 100_00, 'Celular (12/12)', true); // última parcela: não volta
    await add('Alimentação', '2026-09-20', 900_00, 'Mercado');

    // Outubro até o dia 10: salário entrou, aluguel veio do banco com outro nome e valor quase igual, 300 de mercado.
    await add('Pró-labore/Salário', '2026-10-05', 4000_00, 'Salário', true);
    await add('Moradia', '2026-10-10', 1210_00, 'Pagamento a Ivan Negocios');
    await add('Alimentação', '2026-10-08', 300_00, 'Mercado');

    const f = (await monthForecast(ctx.db, userId, '2026-10', '2026-10-10'))!;
    expect(f.balanceCents).toBe(4000_00 - 1210_00 - 300_00);
    expect(f.pendingIncomeCents).toBe(0);
    expect(f.pending).toEqual([{ description: 'Moto (4/10)', categoryName: 'Transporte', kind: 'saida', amountCents: 300_00 }]);
    // Ritmo: histórico 900/30 = 30 por dia (só meses com gasto variável contam); mês atual 300/10 = 30 por dia,
    // sem contar o aluguel que veio do banco. Mistura dá 30 por dia, com 21 dias faltando.
    expect(f.dailyVariableCents).toBe(30_00);
    expect(f.daysLeft).toBe(21);
    expect(f.remainingVariableCents).toBe(630_00);
    expect(f.projectedBalanceCents).toBe(2490_00 - 300_00 - 630_00);
    expect(f.basis).toBe('misto');
    expect(forecastMessage(f).replace(/\s/g, ' ')).toBe(
      'Se o ritmo continuar, você fecha o mês com R$ 1.560,00 sobrando (previsão para 31/10). Conta: hoje o saldo é R$ 2.490,00, faltam R$ 300,00 de contas fixas, e uns R$ 630,00 no dia a dia (R$ 30,00 por dia).'
    );
  });

  it('sem histórico usa o ritmo deste mês e conta o salário que ainda não entrou', async () => {
    await add('Pró-labore/Salário', '2026-09-05', 3000_00, 'Salário', true);
    await add('Alimentação', '2026-10-02', 100_00, 'Lanche');
    const f = (await monthForecast(ctx.db, userId, '2026-10', '2026-10-05'))!;
    expect(f.pendingIncomeCents).toBe(3000_00);
    // setembro não tem gasto variável: ritmo vem só de outubro, 100 em 5 dias = 20 por dia
    expect(f.basis).toBe('mes_atual');
    expect(f.dailyVariableCents).toBe(20_00);
    expect(f.projectedBalanceCents).toBe(-100_00 + 3000_00 - 20_00 * 26);
  });

  it('mês que não é o atual não tem previsão', async () => {
    expect(await monthForecast(ctx.db, userId, '2026-09', '2026-10-10')).toBeNull();
  });

  it('vem no resumo do mês', async () => {
    await add('Alimentação', '2026-10-02', 100_00, 'Lanche');
    const s = (await ctx.app.inject({ method: 'GET', url: '/api/summary?month=2026-10&today=2026-10-10', headers: user.headers })).json();
    expect(s.forecast).toMatchObject({ endDate: '2026-10-31', daysLeft: 21 });
    const past = (await ctx.app.inject({ method: 'GET', url: '/api/summary?month=2026-09&today=2026-10-10', headers: user.headers })).json();
    expect(past.forecast).toBeNull();
  });
});

describe('pergunta de previsão', () => {
  it.each(['vou fechar o mês no azul?', 'Quanto vai sobrar no fim do mês?', 'previsão do mês', 'como vou terminar o mês'])('"%s"', (m) => {
    expect(isForecastQuestion(m)).toBe(true);
  });
  it.each(['gastei 50 no mercado', 'quanto gastei este mês?', 'oi'])('não é: "%s"', (m) => {
    expect(isForecastQuestion(m)).toBe(false);
  });

  it('responde sem IA', async () => {
    const ai = await setupAi();
    const body = (await ai.chat('vou fechar o mês no azul?')).json();
    expect(body.reply).toMatch(/^Se o ritmo continuar/);
    await ai.close();
  });
});
