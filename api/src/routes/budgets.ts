import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../server.js';
import { MONTH_RE } from '../lib/money.js';
import { alertMessage, budgetStatus, takeAlerts } from '../lib/budgets.js';

const month = z.string().regex(MONTH_RE, 'Mês no formato AAAA-MM');
const idParam = z.object({ categoryId: z.coerce.number().int().positive() });
const setBody = z.object({
  budgetCents: z.number().int().positive('A meta precisa ser maior que zero').max(1_000_000_000).nullable()
});

export const budgetRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /** Metas do mês: limite, gasto, quanto resta e a faixa (0, 80 ou 100). */
  app.get('/', async (req) => {
    const q = z.object({ month }).parse(req.query);
    return { month: q.month, budgets: await budgetStatus(app.db, req.user.sub, q.month) };
  });

  /** Define ou remove (null) a meta mensal de uma categoria de saída. */
  app.put('/:categoryId', async (req) => {
    const { categoryId } = idParam.parse(req.params);
    const { budgetCents } = setBody.parse(req.body);
    const { rows } = await app.db.query<{ kind: string }>('select kind from categories where id = $1 and user_id = $2', [
      categoryId,
      req.user.sub
    ]);
    if (!rows.length) throw new HttpError(404, 'Categoria não encontrada.');
    if (rows[0].kind !== 'saida') throw new HttpError(400, 'Metas valem só para categorias de saída.');
    await app.db.query('update categories set budget_cents = $3 where id = $1 and user_id = $2', [categoryId, req.user.sub, budgetCents]);
    // Com outro limite, os avisos do mês recomeçam do zero.
    await app.db.query('delete from budget_alerts where user_id = $1 and category_id = $2', [req.user.sub, categoryId]);
    return { categoryId, budgetCents };
  });

  /**
   * Avisos de meta (80% e 100%) ainda não mostrados no mês. Cada aviso sai uma vez só:
   * ao responder, ele já fica marcado como dado.
   */
  app.post('/alerts', async (req) => {
    const body = z.object({ month }).parse(req.body);
    const alerts = await takeAlerts(app.db, req.user.sub, body.month);
    return { alerts: alerts.map((a) => ({ ...a, message: alertMessage(a) })) };
  });
};
