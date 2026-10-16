import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createDefaultCategories } from '../lib/defaults.js';
import { createDemoUser } from '../lib/demo.js';
import { HttpError } from '../server.js';

const registerBody = z.object({
  name: z.string().trim().min(1, 'Informe seu nome').max(80),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(200)
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string()
});

type UserRow = { id: number; name: string; email: string; is_demo: boolean; password_hash: string };

const publicUser = (u: Omit<UserRow, 'password_hash'>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  isDemo: u.is_demo
});

export const authRoutes: FastifyPluginAsync<{ rateLimit: boolean }> = async (app, opts) => {
  const limited = opts.rateLimit ? { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } } : {};

  app.post('/register', limited, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const exists = await app.db.query('select 1 from users where email = $1', [body.email]);
    if (exists.rows.length) throw new HttpError(409, 'Já existe uma conta com esse e-mail.');

    const hash = await bcrypt.hash(body.password, 10);
    const user = await app.db.transaction(async (tx) => {
      const { rows } = await tx.query<UserRow>(
        'insert into users (name, email, password_hash) values ($1, $2, $3) returning *',
        [body.name, body.email, hash]
      );
      await createDefaultCategories(tx, rows[0].id);
      return rows[0];
    });
    reply.code(201);
    return { token: app.jwt.sign({ sub: user.id }), user: publicUser(user) };
  });

  app.post('/login', limited, async (req) => {
    const body = loginBody.parse(req.body);
    const { rows } = await app.db.query<UserRow>('select * from users where email = $1 and not is_demo', [body.email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    return { token: app.jwt.sign({ sub: user.id }), user: publicUser(user) };
  });

  /** Cria uma conta de demonstração nova, com dados fictícios, que expira em 24h. */
  app.post('/demo', limited, async () => {
    await app.db.query(`delete from users where is_demo and created_at < now() - interval '1 day'`);
    const user = await createDemoUser(app.db);
    return { token: app.jwt.sign({ sub: user.id }, { expiresIn: '1d' }), user: publicUser(user) };
  });

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => {
    const { rows } = await app.db.query<UserRow>('select id, name, email, is_demo from users where id = $1', [req.user.sub]);
    if (!rows[0]) throw new HttpError(401, 'Conta não encontrada. Entre de novo.');
    return { user: publicUser(rows[0]) };
  });
};
