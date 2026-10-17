import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../server.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor no formato #RRGGBB');

const createBody = z.object({
  name: z.string().trim().min(1, 'Dê um nome à categoria').max(40),
  kind: z.enum(['entrada', 'saida']),
  color: color.optional()
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: color.optional(),
  archived: z.boolean().optional()
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const SELECT = `select c.id, c.name, c.kind, c.color, c.position, c.archived, c.budget_cents as "budgetCents",
  (select count(*)::int from transactions t where t.category_id = c.id) as "transactionCount"
  from categories c`;

export const categoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const { rows } = await app.db.query(`${SELECT} where c.user_id = $1 order by c.kind, c.position, c.name`, [req.user.sub]);
    return { categories: rows };
  });

  app.post('/', async (req, reply) => {
    const body = createBody.parse(req.body);
    const dup = await app.db.query('select 1 from categories where user_id = $1 and lower(name) = lower($2) and kind = $3', [
      req.user.sub,
      body.name,
      body.kind
    ]);
    if (dup.rows.length) throw new HttpError(409, 'Você já tem uma categoria com esse nome.');
    const { rows } = await app.db.query<{ id: number }>(
      `insert into categories (user_id, name, kind, color, position)
       values ($1, $2, $3, coalesce($4, '#5B6870'),
         (select coalesce(max(position), 0) + 1 from categories where user_id = $1))
       returning id`,
      [req.user.sub, body.name, body.kind, body.color ?? null]
    );
    reply.code(201);
    return { category: (await app.db.query(`${SELECT} where c.id = $1`, [rows[0].id])).rows[0] };
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    const { rows } = await app.db.query(
      `update categories set
         name = coalesce($3, name),
         color = coalesce($4, color),
         archived = coalesce($5, archived)
       where id = $1 and user_id = $2 returning id`,
      [id, req.user.sub, body.name ?? null, body.color ?? null, body.archived ?? null]
    );
    if (!rows.length) throw new HttpError(404, 'Categoria não encontrada.');
    return { category: (await app.db.query(`${SELECT} where c.id = $1`, [id])).rows[0] };
  });

  /** Só apaga categoria sem lançamentos; com lançamentos, o app oferece arquivar. */
  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const used = await app.db.query('select 1 from transactions where category_id = $1 limit 1', [id]);
    if (used.rows.length) throw new HttpError(409, 'Essa categoria tem lançamentos. Arquive em vez de excluir.');
    const { rows } = await app.db.query('delete from categories where id = $1 and user_id = $2 returning id', [id, req.user.sub]);
    if (!rows.length) throw new HttpError(404, 'Categoria não encontrada.');
    return reply.code(204).send();
  });
};
