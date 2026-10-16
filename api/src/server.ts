import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { authRoutes } from './routes/auth.js';
import { categoryRoutes } from './routes/categories.js';
import { transactionRoutes } from './routes/transactions.js';
import { summaryRoutes } from './routes/summary.js';
import { importExportRoutes } from './routes/import-export.js';

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
  await app.register(importExportRoutes, { prefix: '/api' });

  return app;
}
