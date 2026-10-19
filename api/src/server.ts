import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { authRoutes } from './routes/auth.js';
import { categoryRoutes } from './routes/categories.js';
import { budgetRoutes } from './routes/budgets.js';
import { transactionRoutes } from './routes/transactions.js';
import { summaryRoutes } from './routes/summary.js';
import { importExportRoutes } from './routes/import-export.js';
import { assistantRoutes, createAssistant, type AssistantOptions } from './assistant/route.js';
import { whatsappRoutes } from './whatsapp/route.js';
import { telegramRoutes } from './telegram/route.js';
import { createTelegramClient, webhookSecret, type TelegramClient } from './telegram/client.js';
import { createWhatsAppSender, type WhatsAppSender } from './whatsapp/client.js';
import { createProviderSession, verifyApiKey } from './assistant/providers.js';
import { createSecretBox } from './lib/secret.js';
import { syncRoutes, tokenRoutes, hashToken, SCOPE_ROUTES } from './routes/sync.js';
import { notificationRoutes } from './routes/notifications.js';
import { mcpRoutes } from './mcp/route.js';
import { docsHtml, openapi } from './openapi.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** "MÉTODO /caminho" de cada rota registrada (para o teste da documentação). */
    routeIndex: Set<string>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: number };
    user: { sub: number };
  }
}

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  corsOrigin?: string[] | boolean;
  logger?: boolean;
  rateLimit?: boolean;
  /** Segredo para criptografar as chaves de IA dos usuários. Sem ele, usa um derivado do JWT_SECRET. */
  aiKeySecret?: string;
  assistant?: Partial<AssistantOptions>;
  /** Assistente pelo WhatsApp (Cloud API). Sem token, número, verify token e app secret, fica desligado. */
  whatsapp?: {
    token?: string;
    phoneNumberId?: string;
    verifyToken?: string;
    appSecret?: string;
    displayNumber?: string;
    apiVersion?: string;
    /** Substitui o envio real (testes). */
    sender?: WhatsAppSender;
  };
  /** Assistente pelo Telegram. Com o token do bot e o endereço público, o webhook é registrado ao iniciar. */
  telegram?: {
    token?: string;
    /** Endereço público da API (no Render, RENDER_EXTERNAL_URL). */
    publicUrl?: string;
    /** Substitui a Bot API real (testes). */
    client?: TelegramClient;
  };
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function buildApp(opts: AppOptions) {
  // No log, a chave do conector que vier no caminho (/mcp/saldo_...) aparece mascarada.
  const logger = opts.logger
    ? {
        serializers: {
          req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.replace(/\/mcp\/[^/?#]+/, '/mcp/***') })
        }
      }
    : false;
  const app = Fastify({ logger, bodyLimit: 3 * 1024 * 1024 });

  app.decorate('db', opts.db);
  app.decorate('routeIndex', new Set<string>());
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD' && m !== 'OPTIONS') app.routeIndex.add(`${m} ${r.url}`);
  });
  await app.register(cors, { origin: opts.corsOrigin ?? true });
  await app.register(jwt, { secret: opts.jwtSecret, sign: { expiresIn: '30d' } });
  await app.register(rateLimit, { global: false });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    // Chave de sincronização (tarefa agendada): só pode chamar as rotas de /api/sync.
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer saldo_')) {
      const { rows } = await opts.db.query<{ user_id: number; scope: string }>(
        'update api_tokens set last_used_at = now() where token_hash = $1 returning user_id, scope',
        [hashToken(header.slice('Bearer '.length).trim())]
      );
      if (!rows[0]) return reply.code(401).send({ error: 'Chave de sincronização inválida ou revogada.' });
      const route = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`;
      if (!SCOPE_ROUTES[rows[0].scope]?.has(route)) {
        return reply.code(403).send({ error: 'Esta chave não vale para esta rota.' });
      }
      req.user = { sub: rows[0].user_id };
      return;
    }
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'Sua sessão expirou. Entre de novo.' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'Confira os campos destacados.',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Erro interno. Tente de novo em instantes.' });
  });

  // Documentação da API: /docs (Swagger UI) lendo /openapi.json.
  app.get('/openapi.json', async () => openapi);
  app.get('/docs', async (_req, reply) => reply.type('text/html; charset=utf-8').send(docsHtml));

  /** Para o despertador do GitHub Actions: mantém o servidor acordado sem acordar o banco. */
  app.get('/api/ping', async () => ({ ok: true }));

  app.get('/api/health', async () => {
    await opts.db.query('select 1');
    return { ok: true };
  });

  await app.register(authRoutes, { prefix: '/api/auth', rateLimit: opts.rateLimit ?? true });
  await app.register(categoryRoutes, { prefix: '/api/categories' });
  await app.register(transactionRoutes, { prefix: '/api/transactions' });
  await app.register(summaryRoutes, { prefix: '/api/summary' });
  await app.register(budgetRoutes, { prefix: '/api/budgets' });
  await app.register(importExportRoutes, { prefix: '/api' });
  await app.register(tokenRoutes, { prefix: '/api/tokens' });
  await app.register(syncRoutes, { prefix: '/api/sync' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  const assistantOptions: AssistantOptions = {
    secretBox: createSecretBox(opts.aiKeySecret ?? opts.jwtSecret),
    providerFactory: createProviderSession,
    verifyKey: (provider, key) => verifyApiKey(provider, key),
    timeZone: 'America/Sao_Paulo',
    hourlyLimit: 60,
    rateLimit: opts.rateLimit ?? true,
    ...opts.assistant
  };
  // Um assistente só para o app e o WhatsApp: mesmo limite por hora, mesmas regras.
  const assistant = createAssistant(opts.db, assistantOptions);
  await app.register(assistantRoutes, { prefix: '/api/assistant', ...assistantOptions, assistant });

  const inflight = new Set<Promise<unknown>>();
  app.decorate('chatIdle', async () => {
    while (inflight.size) await Promise.allSettled([...inflight]);
  });
  const wa = opts.whatsapp ?? {};
  const waEnabled = Boolean((wa.sender || (wa.token && wa.phoneNumberId)) && wa.verifyToken && wa.appSecret);
  await app.register(whatsappRoutes, {
    prefix: '/api/whatsapp',
    enabled: waEnabled,
    verifyToken: wa.verifyToken,
    appSecret: wa.appSecret,
    displayNumber: wa.displayNumber,
    sender: wa.sender ?? (wa.token && wa.phoneNumberId ? createWhatsAppSender({ token: wa.token, phoneNumberId: wa.phoneNumberId, apiVersion: wa.apiVersion }) : undefined),
    assistant,
    track: (work) => {
      inflight.add(work);
      void work.finally(() => inflight.delete(work));
    }
  });

  const tg = opts.telegram ?? {};
  const tgClient = tg.client ?? (tg.token ? createTelegramClient(tg.token) : undefined);
  const tgSecret = tg.token ? webhookSecret(tg.token) : tg.client ? 'segredo-de-teste' : undefined;
  let tgUsername: string | null = null;
  await app.register(telegramRoutes, {
    prefix: '/api/telegram',
    client: tgClient,
    secret: tgSecret,
    username: () => tgUsername,
    assistant,
    track: (work) => {
      inflight.add(work);
      void work.finally(() => inflight.delete(work));
    }
  });
  if (tgClient) {
    // Descobre o @ do bot e aponta o webhook para cá. Falha aqui não derruba a API: só o Telegram fica fora.
    app.addHook('onReady', async () => {
      try {
        tgUsername = (await tgClient.getMe()).username;
        if (tg.publicUrl && tgSecret) await tgClient.setWebhook(`${tg.publicUrl.replace(/\/$/, '')}/api/telegram/webhook`, tgSecret);
        app.log.info({ bot: tgUsername }, 'Telegram ligado');
      } catch (err) {
        app.log.error({ err }, 'não consegui ligar o Telegram');
      }
    });
  }

  await app.register(mcpRoutes, { prefix: '/mcp', timeZone: opts.assistant?.timeZone ?? 'America/Sao_Paulo' });

  return app;
}
