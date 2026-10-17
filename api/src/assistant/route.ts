import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../server.js';
import type { Db } from '../db.js';
import type { SecretBox } from '../lib/secret.js';
import { TX_SELECT } from '../routes/transactions.js';
import { buildSystemPrompt } from './prompt.js';
import { PROVIDERS, ProviderError, type ProviderFactory, type ProviderId, type ToolResult, type Turn } from './providers.js';
import { isDeleteLastCommand, parseBudgetQuestion, parseByRules, type HistoryHint } from './rules.js';
import { alertMessage, budgetStatus, remainingMessage, takeAlerts } from '../lib/budgets.js';
import { loadHabits } from '../lib/habits.js';
import { TOOLS, findExpenseCategory, insertTransaction, runTool, type CategoryRow, type CreatedTransaction, type ToolContext } from './tools.js';

export interface AssistantOptions {
  secretBox: SecretBox;
  providerFactory: ProviderFactory;
  verifyKey: (provider: ProviderId, apiKey: string) => Promise<void>;
  timeZone: string;
  /** Mensagens por hora por usuário (protege o servidor e a conta de IA do usuário contra laços). */
  hourlyLimit: number;
  rateLimit?: boolean;
}

const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(40),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const providerId = z.enum(['claude', 'openai', 'gemini']);
const settingsBody = z.object({
  provider: providerId,
  apiKey: z.string().trim().min(10, 'Cole a chave completa').max(400).optional(),
  model: z
    .string()
    .trim()
    .max(80)
    .regex(/^[\w.\-:/]*$/, 'Nome de modelo inválido')
    .optional()
});

const MAX_TOOL_ROUNDS = 6;

interface SettingsRow {
  provider: ProviderId;
  model: string;
  key_encrypted: string;
  key_hint: string;
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof ProviderError) {
    const status = { auth: 400, quota: 429, model: 400, unavailable: 503, other: 502 }[err.kind];
    return new HttpError(status, err.message);
  }
  return new HttpError(502, 'A IA não respondeu. Tente de novo ou use o botão + para lançar.');
}

export const assistantRoutes: FastifyPluginAsync<AssistantOptions> = async (app, opts) => {
  app.addHook('onRequest', app.authenticate);

  const hourly = new Map<number, number[]>();
  const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: opts.timeZone }).format(new Date());

  /** Aceita a data do aparelho (fuso do usuário) se estiver a no máximo 1 dia da data do servidor. */
  const resolveToday = (client?: string) => {
    const server = localToday();
    if (!client) return server;
    return Math.abs(Date.parse(client) - Date.parse(server)) / 86_400_000 <= 1 ? client : server;
  };

  function checkLimit(userId: number) {
    const now = Date.now();
    const recent = (hourly.get(userId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= opts.hourlyLimit) throw new HttpError(429, 'Muitas mensagens em pouco tempo. Espere alguns minutos.');
    recent.push(now);
    hourly.set(userId, recent);
  }

  const loadSettings = async (userId: number) =>
    (await app.db.query<SettingsRow>('select provider, model, key_encrypted, key_hint from ai_settings where user_id = $1', [userId])).rows[0];

  const publicSettings = (s?: SettingsRow) => ({
    configured: Boolean(s),
    provider: s?.provider ?? null,
    model: s?.model ?? null,
    keyHint: s?.key_hint ?? null,
    providers: PROVIDERS
  });

  // ------------------------------------------------------------ ajustes da IA

  app.get('/status', async (req) => {
    const s = await loadSettings(req.user.sub);
    return { mode: s ? 'ia' : 'simples', provider: s?.provider ?? null, model: s?.model ?? null };
  });

  app.get('/settings', async (req) => publicSettings(await loadSettings(req.user.sub)));

  const limited = opts.rateLimit === false ? {} : { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /** Conecta ou troca a IA. A chave é testada antes de ser salva e nunca é devolvida. */
  app.put('/settings', limited, async (req) => {
    const body = settingsBody.parse(req.body);
    const userId = req.user.sub;
    const current = await loadSettings(userId);
    const model = body.model || (current?.provider === body.provider ? current.model : PROVIDERS[body.provider].defaultModel);

    if (!body.apiKey) {
      if (!current || current.provider !== body.provider) throw new HttpError(400, 'Cole a chave de API para conectar.');
      await app.db.query('update ai_settings set model = $2, updated_at = now() where user_id = $1', [userId, model]);
      return publicSettings(await loadSettings(userId));
    }

    try {
      await opts.verifyKey(body.provider, body.apiKey);
    } catch (err) {
      throw toHttpError(err);
    }
    await app.db.query(
      `insert into ai_settings (user_id, provider, model, key_encrypted, key_hint) values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set provider = excluded.provider, model = excluded.model,
         key_encrypted = excluded.key_encrypted, key_hint = excluded.key_hint, updated_at = now()`,
      [userId, body.provider, model, opts.secretBox.encrypt(body.apiKey), body.apiKey.slice(-4)]
    );
    return publicSettings(await loadSettings(userId));
  });

  app.delete('/settings', async (req, reply) => {
    await app.db.query('delete from ai_settings where user_id = $1', [req.user.sub]);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ conversa

  app.post('/chat', async (req) => {
    const body = chatBody.parse(req.body);
    const userId = req.user.sub;
    const last = body.messages[body.messages.length - 1];
    if (last.role !== 'user') throw new HttpError(400, 'A última mensagem precisa ser do usuário.');
    checkLimit(userId);

    const categories = (
      await app.db.query<CategoryRow>('select id, name, kind from categories where user_id = $1 and not archived order by kind, position', [userId])
    ).rows;
    const today = resolveToday(body.today);
    const ctx: ToolContext = { db: app.db, userId, categories, today, created: [], updated: [], deleted: [] };
    const habits = await loadHabits(app.db, userId);

    const settings = await loadSettings(userId);
    if (!settings) return simpleMode(ctx, last.content, habits);

    let apiKey: string;
    try {
      apiKey = opts.secretBox.decrypt(settings.key_encrypted);
    } catch {
      throw new HttpError(400, 'Não consegui ler a chave salva. Conecte a IA de novo em Ajustes.');
    }

    const recent = (
      await app.db.query<CreatedTransaction>(`${TX_SELECT} where t.user_id = $1 order by t.created_at desc, t.id desc limit 12`, [userId])
    ).rows;

    // Histórico: começa sempre numa mensagem do usuário e guarda só as últimas trocas.
    let history = body.messages.slice(-16);
    while (history[0]?.role !== 'user') history = history.slice(1);

    const session = opts.providerFactory({ provider: settings.provider, apiKey, model: settings.model });
    const system = buildSystemPrompt({ categories, today, history: habits, recent });

    let reply = '';
    try {
      let turn: Turn = await session.start({ system, history, tools: TOOLS });
      for (let round = 0; round < MAX_TOOL_ROUNDS && turn.toolCalls.length; round++) {
        const results: ToolResult[] = [];
        for (const call of turn.toolCalls) {
          const r = await runTool(call.name, call.input, ctx);
          results.push({ call, content: r.content, isError: r.isError });
        }
        turn = await session.continue(results);
      }
      reply = turn.text;
    } catch (err) {
      req.log.warn({ err, provider: settings.provider }, 'falha na IA do usuário');
      if (ctx.created.length || ctx.updated.length || ctx.deleted.length) {
        // O que já foi gravado continua valendo; só a frase final não veio.
        return respond(ctx, 'Fiz as mudanças abaixo, mas a IA parou de responder antes de terminar.', 'ia');
      }
      throw toHttpError(err);
    }

    if (!reply) reply = ctx.created.length || ctx.updated.length || ctx.deleted.length ? 'Pronto.' : 'Não consegui entender. Pode dizer o valor e o que foi?';
    return respond(ctx, reply, 'ia');
  });
};

const changes = (ctx: ToolContext) => ({ transactions: ctx.created, updated: ctx.updated, deleted: ctx.deleted });

/** Resposta do chat. Se algum lançamento levou uma meta a 80% ou 100%, o aviso vai junto (e não se repete depois). */
async function respond(ctx: ToolContext, reply: string, mode: 'ia' | 'simples') {
  const touched = ctx.created.length + ctx.updated.length > 0;
  const alerts = touched ? await takeAlerts(ctx.db, ctx.userId, ctx.today.slice(0, 7)).catch(() => []) : [];
  return {
    reply,
    ...changes(ctx),
    alerts: alerts.map((a) => ({ categoryId: a.categoryId, level: a.level, message: alertMessage(a) })),
    mode
  };
}

/** "quanto ainda posso gastar em mercado?" sem IA conectada. */
async function answerBudgetQuestion(ctx: ToolContext, category: string) {
  const month = ctx.today.slice(0, 7);
  let ids: number[] | undefined;
  if (category) {
    const cat = findExpenseCategory(ctx.categories, category);
    if (!cat)
      return `Não achei a categoria "${category}". Suas categorias de saída: ${ctx.categories
        .filter((c) => c.kind === 'saida')
        .map((c) => c.name)
        .join(', ')}.`;
    ids = [cat.id];
  }
  const status = await budgetStatus(ctx.db, ctx.userId, month, ids);
  if (!status.length) {
    return category
      ? 'Essa categoria ainda não tem meta. Defina em Ajustes, na parte Metas por categoria.'
      : 'Você ainda não tem metas. Defina em Ajustes, na parte Metas por categoria.';
  }
  return status.map((s) => remainingMessage(s, ctx.today, month)).join('\n');
}

async function simpleMode(ctx: ToolContext, message: string, habits: HistoryHint[]) {
  if (isDeleteLastCommand(message)) {
    const last = (
      await ctx.db.query<CreatedTransaction>(`${TX_SELECT} where t.user_id = $1 order by t.created_at desc, t.id desc limit 1`, [ctx.userId])
    ).rows[0];
    if (!last) return respond(ctx, 'Você ainda não tem lançamentos.', 'simples');
    await ctx.db.query('delete from transactions where id = $1 and user_id = $2', [last.id, ctx.userId]);
    ctx.deleted.push(last);
    return respond(ctx, `Apaguei o último lançamento: ${last.description || last.categoryName}.`, 'simples');
  }

  const question = parseBudgetQuestion(message);
  if (question) return respond(ctx, await answerBudgetQuestion(ctx, question.category), 'simples');

  const items = parseByRules(message, ctx.today, habits);
  if (!items.length) {
    return respond(
      ctx,
      'Não achei um valor nessa frase. Tente algo como "gastei 45,90 no mercado ontem" ou "recebi 4.200 de salário". Para corrigir lançamentos ou fazer perguntas, conecte sua IA em Ajustes.',
      'simples'
    );
  }
  for (const it of items) await insertTransaction(ctx, it);
  const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const parts = ctx.created.map((t) => `${fmt(t.amountCents)} em ${t.categoryName}`);
  return respond(ctx, `Lancei ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}` : parts[0]}.`, 'simples');
}
