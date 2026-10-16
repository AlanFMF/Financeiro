import type { FastifyPluginAsync } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { HttpError } from '../server.js';
import { buildSystemPrompt } from './prompt.js';
import { isDeleteLastCommand, parseByRules, type HistoryHint } from './rules.js';
import { TOOLS, insertTransaction, runTool, type CategoryRow, type CreatedTransaction, type ToolContext } from './tools.js';
import { TX_SELECT } from '../routes/transactions.js';
import type { Db } from '../db.js';

/** Para cada descrição, a categoria que o usuário mais usou com ela. */
async function loadHabits(db: Db, userId: number): Promise<HistoryHint[]> {
  const { rows } = await db.query<{ description: string; category: string; kind: 'entrada' | 'saida' }>(
    `select distinct on (lower(t.description)) t.description, c.name as category, c.kind
     from (
       select category_id, description, count(*) as n, max(date) as last
       from transactions
       where user_id = $1 and description <> ''
       group by category_id, description
     ) t join categories c on c.id = t.category_id
     order by lower(t.description), t.n desc, t.last desc`,
    [userId]
  );
  // Mais frequentes primeiro, para o prompt levar os hábitos mais úteis.
  const freq = await db.query<{ d: string; n: string | number }>(
    `select lower(description) as d, count(*) as n from transactions where user_id = $1 and description <> '' group by 1`,
    [userId]
  );
  const count = new Map(freq.rows.map((r) => [r.d, Number(r.n)]));
  return rows
    .map((r) => ({ ...r, description: r.description.replace(/\s*\(\d+\/\d+\)\s*$/, '') }))
    .sort((a, b) => (count.get(b.description.toLowerCase()) ?? 0) - (count.get(a.description.toLowerCase()) ?? 0))
    .slice(0, 300);
}

/** Função que chama o modelo. Em produção é a API da Claude; nos testes, um modelo falso. */
export type Llm = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export function createClaudeLlm(apiKey: string): Llm {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 });
  return (params) => client.messages.create(params);
}

export interface AssistantOptions {
  llm: Llm | null;
  model: string;
  timeZone: string;
  /** Mensagens por hora para contas normais. */
  hourlyLimit: number;
  /** Mensagens no total por conta de demonstração. */
  demoLimit: number;
  /** Teto diário somando todas as contas de demonstração (protege o custo da demo pública). */
  demoDailyLimit: number;
}

const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(40),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const MAX_TOOL_ROUNDS = 6;

export const assistantRoutes: FastifyPluginAsync<AssistantOptions> = async (app, opts) => {
  app.addHook('onRequest', app.authenticate);

  const hourly = new Map<number, number[]>();
  const demoUsage = new Map<number, number>();
  let demoDay = '';
  let demoToday = 0;

  const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: opts.timeZone }).format(new Date());

  /** Aceita a data do aparelho (fuso do usuário) se estiver a no máximo 1 dia da data do servidor. */
  const resolveToday = (client?: string) => {
    const server = localToday();
    if (!client) return server;
    const diff = Math.abs(Date.parse(client) - Date.parse(server)) / 86_400_000;
    return diff <= 1 ? client : server;
  };

  function checkLimits(userId: number, isDemo: boolean) {
    if (isDemo) {
      const today = localToday();
      if (today !== demoDay) {
        demoDay = today;
        demoToday = 0;
      }
      const used = demoUsage.get(userId) ?? 0;
      if (used >= opts.demoLimit) throw new HttpError(429, `A demonstração permite ${opts.demoLimit} mensagens ao assistente. Crie uma conta para continuar.`);
      if (demoToday >= opts.demoDailyLimit) throw new HttpError(429, 'O assistente da demonstração atingiu o limite de hoje. Tente amanhã ou crie uma conta.');
      demoUsage.set(userId, used + 1);
      demoToday++;
      return;
    }
    const now = Date.now();
    const recent = (hourly.get(userId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= opts.hourlyLimit) throw new HttpError(429, 'Muitas mensagens em pouco tempo. Espere alguns minutos.');
    recent.push(now);
    hourly.set(userId, recent);
  }

  app.get('/status', async () => ({ mode: opts.llm ? 'ia' : 'simples', model: opts.llm ? opts.model : null }));

  app.post('/chat', async (req) => {
    const body = chatBody.parse(req.body);
    const userId = req.user.sub;
    const last = body.messages[body.messages.length - 1];
    if (last.role !== 'user') throw new HttpError(400, 'A última mensagem precisa ser do usuário.');

    const user = (await app.db.query<{ is_demo: boolean }>('select is_demo from users where id = $1', [userId])).rows[0];
    if (!user) throw new HttpError(401, 'Conta não encontrada. Entre de novo.');
    checkLimits(userId, user.is_demo);

    const categories = (
      await app.db.query<CategoryRow>('select id, name, kind from categories where user_id = $1 and not archived order by kind, position', [userId])
    ).rows;
    const today = resolveToday(body.today);
    const ctx: ToolContext = { db: app.db, userId, categories, today, created: [], updated: [], deleted: [] };
    const habits = await loadHabits(app.db, userId);

    if (!opts.llm) return simpleMode(ctx, last.content, habits);

    const recent = (
      await app.db.query<CreatedTransaction>(`${TX_SELECT} where t.user_id = $1 order by t.created_at desc, t.id desc limit 12`, [userId])
    ).rows;

    // Histórico: começa sempre numa mensagem do usuário e guarda só as últimas trocas.
    let history = body.messages.slice(-16);
    while (history[0]?.role !== 'user') history = history.slice(1);
    const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
    const system = buildSystemPrompt({ categories, today, history: habits, recent });

    let reply = '';
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await opts.llm({ model: opts.model, max_tokens: 1024, system, tools: TOOLS, messages });
        messages.push({ role: 'assistant', content: res.content });
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (res.stop_reason !== 'tool_use') {
          reply = text;
          break;
        }
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type !== 'tool_use') continue;
          const r = await runTool(block.name, (block.input ?? {}) as Record<string, unknown>, ctx);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      req.log.error(err, 'falha na API da Claude');
      if (ctx.created.length || ctx.updated.length || ctx.deleted.length) {
        // O que já foi gravado continua valendo; só a frase final não veio.
        return { reply: 'Fiz as mudanças abaixo, mas a IA parou de responder antes de terminar.', ...changes(ctx), mode: 'ia' };
      }
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      if (status === 401 || status === 403) throw new HttpError(502, 'A chave da API da Claude foi recusada. Confira ANTHROPIC_API_KEY no servidor.');
      if (status === 429 || status === 529) throw new HttpError(503, 'A IA está ocupada agora. Tente de novo em alguns segundos.');
      throw new HttpError(502, 'A IA não respondeu. Tente de novo ou use o botão + para lançar.');
    }

    if (!reply) reply = ctx.created.length || ctx.updated.length || ctx.deleted.length ? 'Pronto.' : 'Não consegui entender. Pode dizer o valor e o que foi?';
    return { reply, ...changes(ctx), mode: 'ia' };
  });
};

const changes = (ctx: ToolContext) => ({ transactions: ctx.created, updated: ctx.updated, deleted: ctx.deleted });

async function simpleMode(ctx: ToolContext, message: string, habits: HistoryHint[]) {
  if (isDeleteLastCommand(message)) {
    const last = (
      await ctx.db.query<CreatedTransaction>(`${TX_SELECT} where t.user_id = $1 order by t.created_at desc, t.id desc limit 1`, [ctx.userId])
    ).rows[0];
    if (!last) return { reply: 'Você ainda não tem lançamentos.', ...changes(ctx), mode: 'simples' };
    await ctx.db.query('delete from transactions where id = $1 and user_id = $2', [last.id, ctx.userId]);
    ctx.deleted.push(last);
    return { reply: `Apaguei o último lançamento: ${last.description || last.categoryName}.`, ...changes(ctx), mode: 'simples' };
  }

  const items = parseByRules(message, ctx.today, habits);
  if (!items.length) {
    return {
      reply:
        'Não achei um valor nessa frase. Tente algo como "gastei 45,90 no mercado ontem" ou "recebi 4.200 de salário". Para corrigir ou fazer perguntas, ligue a IA com a chave da API.',
      ...changes(ctx),
      mode: 'simples'
    };
  }
  for (const it of items) await insertTransaction(ctx, it);
  const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const parts = ctx.created.map((t) => `${fmt(t.amountCents)} em ${t.categoryName}`);
  return {
    reply: `Lancei ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}` : parts[0]}.`,
    ...changes(ctx),
    mode: 'simples'
  };
}
