import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../server.js';
import { loadHabits } from '../lib/habits.js';
import { categorizeBank, cleanBankDescription, isCardBillPayment } from '../lib/bank.js';
import { EXTRA_COLORS } from '../lib/defaults.js';
import { alertMessage, budgetStatus, type BudgetAlert } from '../lib/budgets.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Rotas que uma chave de sincronização pode chamar. Todo o resto exige login normal. */
export const TOKEN_ROUTES = new Set(['POST /api/sync/bank', 'GET /api/sync/status']);

// ------------------------------------------------------------------ chaves (só com login normal)

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const { rows } = await app.db.query(
      `select id, name, scope, token_hint as hint, created_at as "createdAt", last_used_at as "lastUsedAt"
       from api_tokens where user_id = $1 order by created_at desc`,
      [req.user.sub]
    );
    return { tokens: rows };
  });

  /** Cria uma chave. Ela aparece só nesta resposta; o servidor guarda apenas o hash. */
  app.post('/', async (req, reply) => {
    const { name, scope } = z
      .object({ name: z.string().trim().min(1, 'Dê um nome à chave').max(40), scope: z.enum(['sync', 'mcp']).default('sync') })
      .parse(req.body);
    const count = (await app.db.query<{ n: number }>('select count(*)::int as n from api_tokens where user_id = $1', [req.user.sub])).rows[0].n;
    if (count >= 10) throw new HttpError(400, 'Você já tem 10 chaves. Revogue uma antes de criar outra.');
    const token = `saldo_${randomBytes(24).toString('base64url')}`;
    const { rows } = await app.db.query(
      `insert into api_tokens (user_id, name, scope, token_hash, token_hint) values ($1, $2, $3, $4, $5)
       returning id, name, scope, token_hint as hint, created_at as "createdAt", last_used_at as "lastUsedAt"`,
      [req.user.sub, name, scope, hashToken(token), token.slice(-4)]
    );
    reply.code(201);
    return { token, info: rows[0] };
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { rows } = await app.db.query('delete from api_tokens where id = $1 and user_id = $2 returning id', [id, req.user.sub]);
    if (!rows.length) throw new HttpError(404, 'Chave não encontrada.');
    return reply.code(204).send();
  });
};

// ------------------------------------------------------------------ sincronização (chave ou login)

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');

const syncBody = z.object({
  source: z.string().trim().min(1).max(40),
  notBefore: isoDate.optional(),
  items: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(120),
        date: isoDate,
        amountCents: z.number().int().positive().max(1_000_000_000),
        kind: z.enum(['entrada', 'saida']),
        description: z.string().trim().max(200).default(''),
        bankCategory: z.string().trim().max(80).optional(),
        status: z.enum(['POSTED', 'PENDING']).optional(),
        installment: z.object({ number: z.number().int().min(1), total: z.number().int().min(1) }).optional()
      })
    )
    .max(500)
});

type ItemResult = {
  externalId: string;
  result: 'created' | 'linked' | 'skipped' | 'ignored';
  reason?: string;
  transactionId?: number;
  category?: string;
  kind?: 'entrada' | 'saida';
  amountCents?: number;
};

const TIME_ZONE = process.env.APP_TIMEZONE ?? 'America/Sao_Paulo';
const currentMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date()).slice(0, 7);

export const syncRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/status', async (req) => {
    const { rows } = await app.db.query<{ last: string | null; n: number }>(
      `select max(created_at) as last, count(*)::int as n from bank_refs where user_id = $1`,
      [req.user.sub]
    );
    return { lastSyncAt: rows[0].last, importedRefs: rows[0].n };
  });

  /**
   * Recebe transações do banco e as transforma em lançamentos, sem duplicar:
   * - id já visto: pula (e atualiza o status de pendente para confirmado);
   * - mesmo valor e tipo, até 3 dias de diferença, de um lançamento feito à mão ou de uma compra pendente
   *   que agora veio confirmada com outro id: liga ao lançamento existente;
   * - pagamento de fatura do cartão e datas antes de `notBefore`: ignora;
   * - o resto vira lançamento novo, com descrição limpa e categoria pelo hábito do usuário e pelo banco.
   */
  app.post('/bank', async (req) => {
    const body = syncBody.parse(req.body);
    const userId = req.user.sub;
    const habits = await loadHabits(app.db, userId);

    return app.db.transaction(async (tx) => {
      const cats = (await tx.query<{ id: number; name: string; kind: string }>('select id, name, kind from categories where user_id = $1', [userId])).rows;
      const catId = async (name: string, kind: string) => {
        const found = cats.find((c) => c.name === name && c.kind === kind);
        if (found) return found.id;
        // A categoria padrão foi apagada pelo usuário: recria para não perder o lançamento.
        const { rows } = await tx.query<{ id: number }>(
          `insert into categories (user_id, name, kind, color, position)
           values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from categories where user_id = $1)) returning id`,
          [userId, name, kind, EXTRA_COLORS[0]]
        );
        cats.push({ id: rows[0].id, name, kind });
        return rows[0].id;
      };

      const results: ItemResult[] = [];
      for (const it of body.items) {
        const status = it.status ?? 'POSTED';
        const seen = (
          await tx.query<{ transaction_id: number | null; status: string | null }>(
            'select transaction_id, status from bank_refs where user_id = $1 and external_id = $2',
            [userId, it.externalId]
          )
        ).rows[0];
        if (seen) {
          if (seen.status !== status) {
            await tx.query('update bank_refs set status = $3 where user_id = $1 and external_id = $2', [userId, it.externalId, status]);
          }
          results.push({ externalId: it.externalId, result: 'skipped', reason: seen.transaction_id ? 'já importado' : 'apagado pelo usuário' });
          continue;
        }

        if (isCardBillPayment(it.description, it.bankCategory)) {
          await tx.query('insert into bank_refs (user_id, external_id, transaction_id, status) values ($1, $2, null, $3)', [userId, it.externalId, status]);
          results.push({ externalId: it.externalId, result: 'ignored', reason: 'pagamento de fatura' });
          continue;
        }
        if (body.notBefore && it.date < body.notBefore) {
          results.push({ externalId: it.externalId, result: 'ignored', reason: 'antes da data inicial' });
          continue;
        }

        // Conciliação: lançamento à mão (sem referência do banco) ou compra pendente desta mesma fonte.
        const match = (
          await tx.query<{ id: number }>(
            `select t.id from transactions t join categories c on c.id = t.category_id
             where t.user_id = $1 and c.kind = $2 and t.amount_cents = $3
               and t.date between ($4::date - 3) and ($4::date + 3)
               and (
                 not exists (select 1 from bank_refs r where r.transaction_id = t.id)
                 or ($6 = 'POSTED' and t.source = $5
                     and not exists (select 1 from bank_refs r where r.transaction_id = t.id and r.status = 'POSTED'))
               )
             order by abs(t.date - $4::date), t.id
             limit 1`,
            [userId, it.kind, it.amountCents, it.date, body.source, status]
          )
        ).rows[0];
        if (match) {
          await tx.query('insert into bank_refs (user_id, external_id, transaction_id, status) values ($1, $2, $3, $4)', [
            userId,
            it.externalId,
            match.id,
            status
          ]);
          await tx.query('update transactions set source = coalesce(source, $3) where id = $1 and user_id = $2', [match.id, userId, body.source]);
          results.push({ externalId: it.externalId, result: 'linked', transactionId: match.id });
          continue;
        }

        const description = cleanBankDescription(it.description, it.installment);
        const category = categorizeBank(description, it.kind, it.bankCategory, habits);
        const { rows } = await tx.query<{ id: number }>(
          `insert into transactions (user_id, category_id, date, description, amount_cents, source)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [userId, await catId(category, it.kind), it.date, description, it.amountCents, body.source]
        );
        await tx.query('insert into bank_refs (user_id, external_id, transaction_id, status) values ($1, $2, $3, $4)', [
          userId,
          it.externalId,
          rows[0].id,
          status
        ]);
        results.push({ externalId: it.externalId, result: 'created', transactionId: rows[0].id, category, kind: it.kind, amountCents: it.amountCents });
      }

      const count = (r: ItemResult['result']) => results.filter((x) => x.result === r).length;
      const created = results.filter((x) => x.result === 'created');
      const sum = (kind: 'entrada' | 'saida') => {
        const items = created.filter((x) => x.kind === kind);
        return { count: items.length, cents: items.reduce((s, x) => s + (x.amountCents ?? 0), 0) };
      };

      // Metas do mês que estão em 80% ou mais e receberam lançamento agora: vão no aviso da tarefa.
      // Não marca o aviso como dado: o app ainda mostra o seu quando for aberto.
      const touched = (
        await tx.query<{ category_id: number }>('select distinct category_id from transactions where user_id = $1 and id = any($2::int[])', [
          userId,
          results.filter((x) => x.transactionId).map((x) => x.transactionId!)
        ])
      ).rows.map((r) => r.category_id);
      const alerts = touched.length
        ? (await budgetStatus(tx, userId, currentMonth(), touched)).filter((b): b is BudgetAlert => b.level > 0)
        : [];

      return {
        created: count('created'),
        linked: count('linked'),
        skipped: count('skipped'),
        ignored: count('ignored'),
        summary: { saida: sum('saida'), entrada: sum('entrada') },
        alerts: alerts.map((a) => ({ categoryId: a.categoryId, level: a.level, pct: a.pct, message: alertMessage(a) })),
        items: results
      };
    });
  });
};
