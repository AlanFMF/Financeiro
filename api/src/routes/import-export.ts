import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { normalize, parseTransactionsCsv, toCsv } from '../lib/csv.js';
import { EXTRA_COLORS } from '../lib/defaults.js';

const importBody = z.object({
  csv: z.string().min(1, 'O arquivo está vazio').max(2_500_000),
  year: z.number().int().min(2000).max(2100).optional(),
  dryRun: z.boolean().default(true)
});

export const importExportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /**
   * Importa o CSV de uma aba da planilha ou de um extrato.
   * Com dryRun (padrão) só devolve a prévia; com dryRun=false grava.
   * Linhas idênticas a lançamentos que já existem são puladas, então dá para importar de novo sem duplicar.
   */
  app.post('/import/csv', async (req) => {
    const b = importBody.parse(req.body);
    const userId = req.user.sub;
    const { rows, errors } = parseTransactionsCsv(b.csv, { fallbackYear: b.year });

    const existing = await app.db.query<{ id: number; name: string; kind: string }>(
      'select id, name, kind from categories where user_id = $1',
      [userId]
    );
    const catKey = (name: string, kind: string) => `${kind}:${normalize(name)}`;
    const catMap = new Map(existing.rows.map((c) => [catKey(c.name, c.kind), c.id]));
    const newCategories = [...new Map(
      rows.filter((r) => !catMap.has(catKey(r.category, r.kind))).map((r) => [catKey(r.category, r.kind), { name: r.category, kind: r.kind }])
    ).values()];

    const totals = rows.reduce(
      (acc, r) => ((acc[r.kind === 'entrada' ? 'income' : 'expense'] += r.amountCents), acc),
      { income: 0, expense: 0 }
    );

    if (b.dryRun) {
      return { dryRun: true, rows, errors, newCategories, totals, created: 0, duplicates: 0 };
    }

    return app.db.transaction(async (tx) => {
      for (const [i, c] of newCategories.entries()) {
        const { rows: ins } = await tx.query<{ id: number }>(
          `insert into categories (user_id, name, kind, color, position)
           values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from categories where user_id = $1))
           returning id`,
          [userId, c.name, c.kind, EXTRA_COLORS[i % EXTRA_COLORS.length]]
        );
        catMap.set(catKey(c.name, c.kind), ins[0].id);
      }

      let created = 0;
      let duplicates = 0;
      for (const r of rows) {
        const categoryId = catMap.get(catKey(r.category, r.kind))!;
        const dup = await tx.query(
          `select 1 from transactions where user_id = $1 and category_id = $2 and date = $3
             and description = $4 and amount_cents = $5 limit 1`,
          [userId, categoryId, r.date, r.description, r.amountCents]
        );
        if (dup.rows.length) {
          duplicates++;
          continue;
        }
        await tx.query(
          `insert into transactions (user_id, category_id, date, description, amount_cents)
           values ($1, $2, $3, $4, $5)`,
          [userId, categoryId, r.date, r.description, r.amountCents]
        );
        created++;
      }
      return { dryRun: false, rows: [], errors, newCategories, totals, created, duplicates };
    });
  });

  /** Exporta no mesmo formato da planilha (Data, Categoria, Descrição, Entrada, Saída). */
  app.get('/export.csv', async (req, reply) => {
    const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }).parse(req.query);
    const params: unknown[] = [req.user.sub];
    let filter = '';
    if (year) {
      params.push(`${year}-01-01`);
      filter = `and t.date >= $2::date and t.date < ($2::date + interval '1 year')`;
    }
    const { rows } = await app.db.query<{ date: string; category: string; description: string; kind: string; amount: number }>(
      `select to_char(t.date, 'DD/MM/YYYY') as date, c.name as category, t.description, c.kind, t.amount_cents as amount
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 ${filter} order by t.date, t.id`,
      params
    );
    const money = (cents: number) => (cents / 100).toFixed(2);
    const csv = toCsv([
      ['Data', 'Categoria', 'Descrição', 'Entrada (R$)', 'Saída (R$)'],
      ...rows.map((r) => [
        r.date,
        r.category,
        r.description,
        r.kind === 'entrada' ? money(r.amount) : '',
        r.kind === 'saida' ? money(r.amount) : ''
      ])
    ]);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="saldo-${year ?? 'tudo'}.csv"`);
    return csv;
  });
};
