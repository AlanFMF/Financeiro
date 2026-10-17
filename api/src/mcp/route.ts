import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db.js';
import { hashToken } from '../routes/sync.js';
import { TOOLS, runTool, type CategoryRow, type ToolContext } from '../assistant/tools.js';
import { UNDERSTANDING, calendar, categoryLines, habitLines } from '../assistant/prompt.js';
import { loadHabits } from '../lib/habits.js';
import { alertMessage, takeAlerts } from '../lib/budgets.js';

/**
 * Conector do Claude (MCP remoto, transporte Streamable HTTP sem sessão).
 *
 * A pessoa cria uma chave "mcp" em Ajustes e adiciona https://<api>/mcp como conector personalizado no Claude,
 * com a chave no cabeçalho Authorization. O Claude passa a lançar, corrigir e consultar no Saldo usando a
 * assinatura dela: o servidor não chama nenhuma IA. As ferramentas são as mesmas do chat do app, então a
 * validação e o isolamento por usuário são os mesmos.
 */

export interface McpOptions {
  timeZone: string;
}

const TITLES: Record<string, string> = {
  registrar_lancamentos: 'Lançar gastos e recebimentos',
  corrigir_lancamento: 'Corrigir um lançamento',
  excluir_lancamento: 'Excluir um lançamento',
  consultar_lancamentos: 'Consultar lançamentos',
  consultar_metas: 'Consultar metas do mês',
  definir_meta: 'Definir meta de categoria',
  previsao_do_mes: 'Previsão do fim do mês',
  resumo_do_mes: 'Resumo do mês'
};
const READ_ONLY = new Set(['consultar_lancamentos', 'consultar_metas', 'previsao_do_mes', 'resumo_do_mes']);
const WRITES = new Set(['registrar_lancamentos', 'corrigir_lancamento']);

/** A chave vem no cabeçalho Authorization (recomendado) ou, para clientes sem campo de cabeçalho, no caminho /mcp/<chave>. */
function tokenFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const key = (req.params as { key?: string }).key;
  return key ? decodeURIComponent(key) : null;
}

async function authenticate(db: Db, token: string | null): Promise<number | null> {
  if (!token?.startsWith('saldo_')) return null;
  const { rows } = await db.query<{ user_id: number }>(
    `update api_tokens set last_used_at = now() where token_hash = $1 and scope = 'mcp' returning user_id`,
    [hashToken(token)]
  );
  return rows[0]?.user_id ?? null;
}

function instructions(categories: CategoryRow[], history: Awaited<ReturnType<typeof loadHabits>>, today: string) {
  return `Saldo é o app de controle financeiro pessoal do usuário. Use estas ferramentas quando ele contar um gasto ou recebimento, pedir para corrigir ou apagar um lançamento, ou perguntar sobre os gastos e as metas dele. Valores em reais.

Grave na hora, sem pedir confirmação: o app mostra tudo e permite desfazer. Um item por valor citado. Depois de gravar, confirme em uma ou duas frases (valor, categoria e a data, se não for hoje). Se a resposta de uma ferramenta trouxer AVISO DE META, repasse o aviso ao usuário.

# Como entender o que ele diz
${UNDERSTANDING}

# Categorias (use o nome exato, respeitando o tipo)
Saídas:
${categoryLines(categories, 'saida')}

Entradas:
${categoryLines(categories, 'entrada')}

# Como este usuário costuma categorizar
${habitLines(history)}

# Calendário (fuso de São Paulo)
${calendar(today)}`;
}

export const mcpRoutes: FastifyPluginAsync<McpOptions> = async (app, opts) => {
  const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: opts.timeZone }).format(new Date());

  async function handle(req: FastifyRequest, reply: FastifyReply) {
    const userId = await authenticate(app.db, tokenFrom(req));
    if (!userId) {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="saldo"')
        .send({ error: 'Chave do conector inválida ou revogada. Crie uma em Ajustes > Usar no Claude.' });
    }

    const categories = (
      await app.db.query<CategoryRow>('select id, name, kind from categories where user_id = $1 and not archived order by kind, position', [
        userId
      ])
    ).rows;
    const today = localToday();
    const habits = await loadHabits(app.db, userId);

    const server = new Server(
      { name: 'saldo', title: 'Saldo', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: instructions(categories, habits, today) }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        title: TITLES[t.name],
        description: t.description,
        inputSchema: t.parameters as { type: 'object'; properties?: Record<string, object>; required?: string[] },
        annotations: {
          title: TITLES[t.name],
          readOnlyHint: READ_ONLY.has(t.name),
          destructiveHint: t.name === 'excluir_lancamento',
          idempotentHint: READ_ONLY.has(t.name),
          openWorldHint: false
        }
      }))
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const ctx: ToolContext = { db: app.db, userId, categories, today, created: [], updated: [], deleted: [] };
      const name = request.params.name;
      if (!TOOLS.some((t) => t.name === name)) {
        return { content: [{ type: 'text' as const, text: `Ferramenta desconhecida: ${name}` }], isError: true };
      }
      try {
        const result = await runTool(name, (request.params.arguments ?? {}) as Record<string, unknown>, ctx);
        let text = result.content;
        if (WRITES.has(name) && !result.isError) {
          const alerts = await takeAlerts(app.db, userId, today.slice(0, 7));
          if (alerts.length) text += `\n\nAVISO DE META: ${alerts.map(alertMessage).join(' ')}`;
        }
        return { content: [{ type: 'text' as const, text }], isError: result.isError };
      } catch (err) {
        req.log.warn({ err, tool: name }, 'falha em ferramenta do conector');
        return { content: [{ type: 'text' as const, text: 'Erro ao executar no Saldo. Tente de novo.' }], isError: true };
      }
    });

    // Sem sessão: um servidor e um transporte por requisição, resposta em JSON.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'falha no conector MCP');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno' }, id: null }));
      }
    }
  }

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null });

  for (const url of ['/', '/:key']) {
    app.post(url, { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, handle);
    app.get(url, notAllowed);
    app.delete(url, notAllowed);
  }
};
