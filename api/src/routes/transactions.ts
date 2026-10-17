import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { HttpError } from '../server.js';
import { MONTH_RE, daysInMonth, monthStart, nextInstallment } from '../lib/money.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const month = z.string().regex(MONTH_RE, 'Mês no formato AAAA-MM');

const body = z.object({
  categoryId: z.number().int().positive(),
  date: isoDate,
  description: z.string().trim().max(120).default(''),
  amountCents: z.number().int().positive('O valor precisa ser maior que zero').max(1_000_000_000),
  isFixed: z.boolean().default(false)
});

const listQuery = z.object({
  month: month.optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export const TX_SELECT = `select t.id, to_char(t.date, 'YYYY-MM-DD') as date, t.description,
  t.amount_cents as "amountCents", t.is_fixed as "isFixed", t.source, t.needs_review as "needsReview",
  c.id as "categoryId", c.name as "categoryName", c.kind, c.color
  from transactions t join categories c on c.id = t.category_id`;

async function assertCategory(db: Db, userId: number, categoryId: number) {
  const { rows } = await db.query('select 1 from categories where id = $1 and user_id = $2', [categoryId, userId]);
  if (!rows.length) throw new HttpError(400, 'Categoria inválida.');
}

export const transactionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const q = listQuery.parse(req.query);
    const params: unknown[] = [req.user.sub];
    const where = ['t.user_id = $1'];
    if (q.month) {
      params.push(monthStart(q.month));
      where.push(`t.date >= $${params.length}::date and t.date < ($${params.length}::date + interval '1 month')`);
    }
    if (q.categoryId) {
      params.push(q.categoryId);
      where.push(`t.category_id = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(t.description ilike $${params.length} or c.name ilike $${params.length})`);
    }
    params.push(q.limit);
    const { rows } = await app.db.query(
      `${TX_SELECT} where ${where.join(' and ')} order by t.date desc, t.id desc limit $${params.length}`,
      params
    );
    return { transactions: rows };
  });

  app.post('/', async (req, reply) => {
    const b = body.parse(req.body);
    await assertCategory(app.db, req.user.sub, b.categoryId);
    const { rows } = await app.db.query<{ id: number }>(
      `insert into transactions (user_id, category_id, date, description, amount_cents, is_fixed)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [req.user.sub, b.categoryId, b.date, b.description, b.amountCents, b.isFixed]
    );
    reply.code(201);
    return { transaction: (await app.db.query(`${TX_SELECT} where t.id = $1`, [rows[0].id])).rows[0] };
  });

  app.put('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = body.parse(req.body);
    await assertCategory(app.db, req.user.sub, b.categoryId);
    const { rows } = await app.db.query(
      `update transactions set category_id = $3, date = $4, description = $5, amount_cents = $6,
         is_fixed = $7, needs_review = false, updated_at = now()
       where id = $1 and user_id = $2 returning id`,
      [id, req.user.sub, b.categoryId, b.date, b.description, b.amountCents, b.isFixed]
    );
    if (!rows.length) throw new HttpError(404, 'Lançamento não encontrado.');
    return { transaction: (await app.db.query(`${TX_SELECT} where t.id = $1`, [id])).rows[0] };
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.db.query('delete from transactions where id = $1 and user_id = $2 returning id', [id, req.user.sub]);
    if (!rows.length) throw new HttpError(404, 'Lançamento não encontrado.');
    return reply.code(204).send();
  });

  /** Lançamentos do banco que ainda não foram conferidos, do mais novo para o mais antigo. */
  app.get('/review', async (req) => {
    const { rows } = await app.db.query(`${TX_SELECT} where t.user_id = $1 and t.needs_review order by t.date desc, t.id desc limit 200`, [
      req.user.sub
    ]);
    return { transactions: rows };
  });

  /** Confirma lançamentos como estão. */
  app.post('/review/confirm', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
    const { rows } = await app.db.query(
      'update transactions set needs_review = false where user_id = $1 and id = any($2::int[]) and needs_review returning id',
      [req.user.sub, ids]
    );
    return { confirmed: rows.length };
  });

  /**
   * Troca a categoria de um lançamento a conferir e confirma. Os outros a conferir com a mesma descrição
   * ("Kachin" duas vezes no mês) recebem a mesma categoria. Daí em diante o hábito vale para as próximas importações.
   */
  app.post('/review/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { categoryId } = z.object({ categoryId: z.number().int().positive() }).parse(req.body);
    await assertCategory(app.db, req.user.sub, categoryId);
    const tx = (await app.db.query<{ description: string; kind: string }>(
      `select t.description, c.kind from transactions t join categories c on c.id = t.category_id where t.id = $1 and t.user_id = $2`,
      [id, req.user.sub]
    )).rows[0];
    if (!tx) throw new HttpError(404, 'Lançamento não encontrado.');
    const kind = (await app.db.query<{ kind: string }>('select kind from categories where id = $1', [categoryId])).rows[0].kind;
    if (kind !== tx.kind) throw new HttpError(400, 'Escolha uma categoria do mesmo tipo (entrada ou saída).');
    const { rows } = await app.db.query<{ id: number }>(
      `update transactions t set category_id = $3, needs_review = false, updated_at = now()
       from categories c
       where c.id = t.category_id and t.user_id = $2 and c.kind = $5
         and (t.id = $1 or (t.needs_review and t.description <> '' and lower(t.description) = lower($4)))
       returning t.id`,
      [id, req.user.sub, categoryId, tx.description, tx.kind]
    );
    return { updated: rows.map((r) => r.id) };
  });

  /**
   * Copia os gastos e receitas fixos de um mês para outro.
   * Avança parcelas "(n/N)" e pula as que já terminaram; não duplica o que já foi copiado.
   */
  app.post('/copy-fixed', async (req) => {
    const { from, to } = z.object({ from: month, to: month }).parse(req.body);
    if (from === to) throw new HttpError(400, 'Escolha meses diferentes.');
    const userId = req.user.sub;

    return app.db.transaction(async (tx) => {
      const source = await tx.query<{ categoryId: number; day: number; description: string; amountCents: number }>(
        `select category_id as "categoryId", extract(day from date)::int as day, description, amount_cents as "amountCents"
         from transactions where user_id = $1 and is_fixed
           and date >= $2::date and date < ($2::date + interval '1 month')
         order by date, id`,
        [userId, monthStart(from)]
      );
      const lastDay = daysInMonth(to);
      let created = 0;
      let skipped = 0;
      let finished = 0;

      for (const s of source.rows) {
        const description = nextInstallment(s.description);
        if (description === null) {
          finished++;
          continue;
        }
        const exists = await tx.query(
          `select 1 from transactions where user_id = $1 and category_id = $2 and description = $3 and is_fixed
             and date >= $4::date and date < ($4::date + interval '1 month') limit 1`,
          [userId, s.categoryId, description, monthStart(to)]
        );
        if (exists.rows.length) {
          skipped++;
          continue;
        }
        const date = `${to}-${String(Math.min(s.day, lastDay)).padStart(2, '0')}`;
        await tx.query(
          `insert into transactions (user_id, category_id, date, description, amount_cents, is_fixed)
           values ($1, $2, $3, $4, $5, true)`,
          [userId, s.categoryId, date, description, s.amountCents]
        );
        created++;
      }
      return { created, skipped, finished };
    });
  });
};
