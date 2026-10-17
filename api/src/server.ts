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
import { assistantRoutes, type AssistantOptions } from './assistant/route.js';
import { createProviderSession, verifyApiKey } from './assistant/providers.js';
import { createSecretBox } from './lib/secret.js';
import { syncRoutes, tokenRoutes, hashToken, TOKEN_ROUTES } from './routes/sync.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 3 * 1024 * 1024 });

  app.decorate('db', opts.db);
  await app.register(cors, { origin: opts.corsOrigin ?? true });
  await app.register(jwt, { secret: opts.jwtSecret, sign: { expiresIn: '30d' } });
  await app.register(rateLimit, { global: false });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    // Chave de sincronização (tarefa agendada): só pode chamar as rotas de /api/sync.
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer saldo_')) {
      const { rows } = await opts.db.query<{ user_id: number }>(
        'update api_tokens set last_used_at = now() where token_hash = $1 returning user_id',
        [hashToken(header.slice('Bearer '.length).trim())]
      );
      if (!rows[0]) return reply.code(401).send({ error: 'Chave de sincronização inválida ou revogada.' });
      const route = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`;
      if (!TOKEN_ROUTES.has(route)) return reply.code(403).send({ error: 'Esta chave só pode enviar lançamentos do banco.' });
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
  await app.register(assistantRoutes, {
    prefix: '/api/assistant',
    secretBox: createSecretBox(opts.aiKeySecret ?? opts.jwtSecret),
    providerFactory: createProviderSession,
    verifyKey: (provider, key) => verifyApiKey(provider, key),
    timeZone: 'America/Sao_Paulo',
    hourlyLimit: 60,
    rateLimit: opts.rateLimit ?? true,
    ...opts.assistant
  });

  return app;
}
