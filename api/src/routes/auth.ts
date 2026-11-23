import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
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

const forgotBody = z.object({ email: z.string().trim().toLowerCase().email('E-mail inválido') });
const resetBody = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  code: z.string().trim().regex(/^\d{6}$/, 'O código tem 6 números'),
  password: registerBody.shape.password
});

/** Um jeito de entregar o código de recuperação. Devolve se entregou (ex.: o Telegram só entrega se a conta estiver ligada). */
export interface ResetChannel {
  name: 'telegram' | 'email';
  send(user: { id: number; name: string; email: string }, text: string): Promise<boolean>;
}

export interface AuthOptions {
  rateLimit: boolean;
  /** Segredo do HMAC dos códigos (o mesmo do JWT). */
  secret: string;
  resetChannels: ResetChannel[];
  /** Avisa o servidor da nova versão da senha: sessões com versão anterior deixam de valer. */
  onPasswordChanged: (userId: number, version: number) => void;
}

export const RESET_TTL_MIN = 15;
export const RESET_MAX_ATTEMPTS = 5;
const CHANNEL_LABEL = { telegram: 'pelo Telegram ligado à conta', email: 'por e-mail' } as const;

type UserRow = { id: number; name: string; email: string; is_demo: boolean; password_hash: string; password_version: number };

const publicUser = (u: Pick<UserRow, 'id' | 'name' | 'email' | 'is_demo'>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  isDemo: u.is_demo
});

export const authRoutes: FastifyPluginAsync<AuthOptions> = async (app, opts) => {
  /** Sessão com a versão da senha (pv): trocar a senha derruba as sessões antigas. */
  const session = (u: { id: number; password_version?: number }) => app.jwt.sign({ sub: u.id, pv: u.password_version ?? 0 });
  const limited = opts.rateLimit ? { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } } : {};
  const strict = opts.rateLimit ? { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } } : {};
  const codeHash = (userId: number, code: string) => createHmac('sha256', opts.secret).update(`reset:${userId}:${code}`).digest('hex');
  const channelText = () => {
    const names = opts.resetChannels.map((c) => CHANNEL_LABEL[c.name]);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} ou ${names.at(-1)}` : names[0];
  };

  /**
   * Esqueci minha senha: manda um código de 6 dígitos pelo Telegram ligado à conta e/ou por e-mail.
   * A resposta é a mesma exista ou não a conta, para não revelar quais e-mails estão cadastrados.
   */
  app.post('/forgot', strict, async (req) => {
    const { email } = forgotBody.parse(req.body);
    if (!opts.resetChannels.length) {
      throw new HttpError(503, 'A recuperação de senha ainda não foi configurada neste servidor (Telegram ou e-mail).');
    }
    const answer = {
      message: `Se existir uma conta com esse e-mail, mandamos um código ${channelText()}. Ele vale por ${RESET_TTL_MIN} minutos.`,
      channels: opts.resetChannels.map((c) => c.name)
    };
    const user = (await app.db.query<UserRow>('select id, name, email from users where email = $1 and not is_demo', [email])).rows[0];
    if (!user) return answer;

    // Um pedido por minuto por conta: evita encher o Telegram ou a caixa de entrada.
    const recent = await app.db.query(`select 1 from password_resets where user_id = $1 and created_at > now() - interval '1 minute'`, [user.id]);
    if (recent.rows.length) return answer;

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await app.db.transaction(async (tx) => {
      await tx.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [user.id]);
      await tx.query(`insert into password_resets (user_id, code_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`, [
        user.id,
        codeHash(user.id, code),
        RESET_TTL_MIN
      ]);
    });
    const text = `Saldo: seu código para criar uma nova senha é ${code}. Vale por ${RESET_TTL_MIN} minutos. Se não foi você que pediu, ignore: sua senha continua a mesma.`;
    for (const channel of opts.resetChannels) {
      try {
        await channel.send(user, text);
      } catch (err) {
        req.log.warn({ err, channel: channel.name }, 'falha ao enviar código de recuperação');
      }
    }
    return answer;
  });

  /** Troca a senha com o código recebido e já entra na conta. As sessões abertas antes deixam de valer. */
  app.post('/reset', strict, async (req) => {
    const body = resetBody.parse(req.body);
    const invalid = new HttpError(400, 'Código inválido ou vencido. Peça um novo.');
    const user = (await app.db.query<UserRow>('select id, name, email, is_demo from users where email = $1 and not is_demo', [body.email])).rows[0];
    if (!user) throw invalid;
    const reset = (
      await app.db.query<{ id: number; code_hash: string; attempts: number }>(
        `select id, code_hash, attempts from password_resets
         where user_id = $1 and used_at is null and expires_at > now() order by created_at desc limit 1`,
        [user.id]
      )
    ).rows[0];
    if (!reset) throw invalid;

    const given = Buffer.from(codeHash(user.id, body.code), 'hex');
    if (!timingSafeEqual(given, Buffer.from(reset.code_hash, 'hex'))) {
      const attempts = reset.attempts + 1;
      await app.db.query(
        `update password_resets set attempts = $2::int, used_at = case when $2::int >= $3::int then now() else null end where id = $1`,
        [reset.id, attempts, RESET_MAX_ATTEMPTS]
      );
      const left = RESET_MAX_ATTEMPTS - attempts;
      throw new HttpError(400, left > 0 ? `Código incorreto. Você ainda tem ${left} tentativa${left > 1 ? 's' : ''}.` : 'Código incorreto. Peça um novo.');
    }

    const hash = await bcrypt.hash(body.password, 10);
    const version = await app.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ v: number }>(
        'update users set password_hash = $2, password_version = password_version + 1 where id = $1 returning password_version as v',
        [user.id, hash]
      );
      await tx.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [user.id]);
      return rows[0].v;
    });
    opts.onPasswordChanged(user.id, version);

    for (const channel of opts.resetChannels) {
      channel
        .send(user, 'Saldo: sua senha foi trocada agora. Se não foi você, peça um novo código em "Esqueci minha senha" e troque de novo.')
        .catch((err) => req.log.warn({ err, channel: channel.name }, 'falha ao avisar troca de senha'));
    }
    return { token: session({ id: user.id, password_version: version }), user: publicUser(user) };
  });

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
    return { token: session(user), user: publicUser(user) };
  });

  app.post('/login', limited, async (req) => {
    const body = loginBody.parse(req.body);
    const { rows } = await app.db.query<UserRow>('select * from users where email = $1 and not is_demo', [body.email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    return { token: session(user), user: publicUser(user) };
  });

  /** Cria uma conta de demonstração nova, com dados fictícios, que expira em 24h. */
  app.post('/demo', limited, async () => {
    await app.db.query(`delete from users where is_demo and created_at < now() - interval '1 day'`);
    const user = await createDemoUser(app.db);
    return { token: app.jwt.sign({ sub: user.id }, { expiresIn: '1d' }), user: publicUser(user) };
  });

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => {
    const { rows } = await app.db.query<UserRow>('select id, name, email, is_demo, password_version from users where id = $1', [req.user.sub]);
    if (!rows[0]) throw new HttpError(401, 'Conta não encontrada. Entre de novo.');
    // Renova a sessão a cada abertura do app: quem usa não é deslogado depois de 30 dias.
    return { user: publicUser(rows[0]), token: rows[0].is_demo ? undefined : session(rows[0]) };
  });
};
