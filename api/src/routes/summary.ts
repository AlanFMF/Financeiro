import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MONTH_RE, monthStart, shiftMonth } from '../lib/money.js';
import { monthForecast } from '../lib/forecast.js';

const TIME_ZONE = process.env.APP_TIMEZONE ?? 'America/Sao_Paulo';
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

const month = z.string().regex(MONTH_RE, 'Mês no formato AAAA-MM');

async function totals(app: Parameters<FastifyPluginAsync>[0], userId: number, m: string) {
  const { rows } = await app.db.query<{ income: string | number; expense: string | number }>(
    `select
       coalesce(sum(t.amount_cents) filter (where c.kind = 'entrada'), 0)::int8 as income,
       coalesce(sum(t.amount_cents) filter (where c.kind = 'saida'), 0)::int8 as expense
     from transactions t join categories c on c.id = t.category_id
     where t.user_id = $1 and t.date >= $2::date and t.date < ($2::date + interval '1 month')`,
    [userId, monthStart(m)]
  );
  const income = Number(rows[0].income);
  const expense = Number(rows[0].expense);
  return { income, expense, balance: income - expense };
}

export const summaryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /** Resumo de um mês: totais, comparação com o mês anterior e total por categoria. */
  app.get('/', async (req) => {
    const { month: m, today } = z
      .object({ month, today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.query);
    const userId = req.user.sub;
    const current = await totals(app, userId, m);
    const previous = await totals(app, userId, shiftMonth(m, -1));

    const { rows } = await app.db.query<{ total: string | number }>(
      `select c.id, c.name, c.kind, c.color, sum(t.amount_cents)::int8 as total, count(*)::int as count
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 and t.date >= $2::date and t.date < ($2::date + interval '1 month')
       group by c.id order by c.kind, total desc`,
      [userId, monthStart(m)]
    );
    const fixed = await app.db.query<{ total: string | number }>(
      `select coalesce(sum(t.amount_cents), 0)::int8 as total
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 and t.is_fixed and c.kind = 'saida'
         and t.date >= $2::date and t.date < ($2::date + interval '1 month')`,
      [userId, monthStart(m)]
    );

    return {
      month: m,
      ...current,
      fixedExpense: Number(fixed.rows[0].total),
      previous,
      byCategory: rows.map((r) => ({ ...r, total: Number(r.total) })),
      // Só para o mês corrente: saldo previsto no último dia.
      forecast: await monthForecast(app.db, userId, m, today ?? localToday())
    };
  });

  /** Série dos últimos N meses (até o mês informado), para o gráfico de evolução. */
  app.get('/history', async (req) => {
    const q = z.object({ month, months: z.coerce.number().int().min(2).max(24).default(6) }).parse(req.query);
    const first = shiftMonth(q.month, -(q.months - 1));
    const { rows } = await app.db.query<{ month: string; income: string | number; expense: string | number }>(
      `select to_char(m, 'YYYY-MM') as month,
         coalesce(sum(t.amount_cents) filter (where c.kind = 'entrada'), 0)::int8 as income,
         coalesce(sum(t.amount_cents) filter (where c.kind = 'saida'), 0)::int8 as expense
       from generate_series($2::date, $3::date, interval '1 month') as m
       left join transactions t on t.user_id = $1 and date_trunc('month', t.date) = m
       left join categories c on c.id = t.category_id
       group by m order by m`,
      [req.user.sub, monthStart(first), monthStart(q.month)]
    );
    return { series: rows.map((r) => ({ month: r.month, income: Number(r.income), expense: Number(r.expense) })) };
  });
};
