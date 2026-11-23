import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createBrevoMailer, createResendMailer, mailerFromEnv, type MailMessage } from '../src/lib/mailer.js';

let db: Db | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

afterEach(async () => {
  await app?.close();
  await db?.close();
  app = null;
  db = null;
});

async function setup({ telegram = true, email = true } = {}) {
  const d = await createPgliteDb();
  db = d;
  await migrate(d);
  const tgSent: { to: string; text: string }[] = [];
  const mails: MailMessage[] = [];
  const a = await buildApp({
    db: d,
    jwtSecret: 'test',
    rateLimit: false,
    ...(telegram
      ? {
          telegram: {
            client: {
              sendMessage: async (to, text) => void tgSent.push({ to, text }),
              getMe: async () => ({ username: 'saldo_bot' }),
              setWebhook: async () => {},
              downloadFile: async () => Buffer.alloc(0)
            }
          }
        }
      : {}),
    ...(email ? { mailer: { send: async (m: MailMessage) => void mails.push(m) } } : {})
  });
  app = a;
  await a.ready();
  const reg = await a.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Alan', email: 'alan@x.com', password: 'senha-antiga' } });
  const oldToken = reg.json().token as string;

  const linkTelegram = async () => {
    const { code } = (await a.inject({ method: 'POST', url: '/api/telegram/code', headers: { authorization: `Bearer ${oldToken}` } })).json();
    await a.inject({
      method: 'POST',
      url: '/api/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'segredo-de-teste' },
      payload: { update_id: 1, message: { message_id: 1, chat: { id: 77, type: 'private' }, text: `/start ${code}` } }
    });
    await a.chatIdle();
    tgSent.length = 0;
  };
  const forgot = (email: string) => a.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email } });
  const reset = (code: string, password = 'senha-nova-123', email = 'alan@x.com') =>
    a.inject({ method: 'POST', url: '/api/auth/reset', payload: { email, code, password } });
  const login = (password: string) => a.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'alan@x.com', password } });
  const codeFrom = (text: string) => /\b(\d{6})\b/.exec(text)![1];
  /** Volta o relógio do último pedido, para poder pedir outro código sem esperar 1 minuto. */
  const age = () => d.query(`update password_resets set created_at = created_at - interval '2 minutes'`);
  return { a, d, tgSent, mails, oldToken, linkTelegram, forgot, reset, login, codeFrom, age };
}

describe('esqueci minha senha', () => {
  it('manda o código por e-mail, troca a senha, entra e derruba as sessões antigas', async () => {
    const t = await setup();
    await t.linkTelegram();

    const r = await t.forgot('  ALAN@x.com ');
    expect(r.statusCode).toBe(200);
    expect(r.json().message).toContain('mandamos um código para ele');
    expect(t.mails).toHaveLength(1);
    expect(t.mails[0]).toMatchObject({ to: 'alan@x.com', subject: expect.stringMatching(/^Saldo: seu código é \d{6}$/) });
    expect(t.mails[0].text).toContain('Oi, Alan!');
    expect(t.mails[0].html).toContain('Oi, Alan!');
    // Pelo Telegram, nada: a recuperação é só por e-mail.
    expect(t.tgSent).toEqual([]);
    const code = t.codeFrom(t.mails[0].text);
    // O código não fica guardado em texto no banco.
    const stored = (await t.d.query<{ code_hash: string }>('select code_hash from password_resets')).rows[0];
    expect(stored.code_hash).not.toContain(code);

    const ok = await t.reset(code);
    expect(ok.statusCode).toBe(200);
    const newToken = ok.json().token as string;
    expect(ok.json().user).toMatchObject({ email: 'alan@x.com' });

    expect((await t.login('senha-antiga')).statusCode).toBe(401);
    expect((await t.login('senha-nova-123')).statusCode).toBe(200);
    // Sessão de antes da troca não vale mais; a nova vale.
    const me = (token: string) => t.a.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    const old = await me(t.oldToken);
    expect(old.statusCode).toBe(401);
    expect(old.json().error).toContain('senha foi trocada');
    expect((await me(newToken)).statusCode).toBe(200);
    // O código usado não vale de novo, e um e-mail avisa da troca.
    expect((await t.reset(code, 'outra-senha-99')).statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.mails.at(-1)).toMatchObject({ to: 'alan@x.com', subject: 'Saldo: sua senha foi trocada' });
  });

  it('nome com HTML não vira HTML no e-mail', async () => {
    const t = await setup();
    await t.d.query(`update users set name = '<b>Alan</b> Fabrício'`);
    await t.forgot('alan@x.com');
    expect(t.mails[0].html).toContain('&lt;b&gt;Alan&lt;/b&gt;');
    expect(t.mails[0].html).not.toContain('<b>Alan');
  });

  it('não revela se o e-mail existe', async () => {
    const t = await setup();
    const existe = await t.forgot('alan@x.com');
    const naoExiste = await t.forgot('ninguem@x.com');
    expect(existe.json()).toEqual(naoExiste.json());
    expect(t.mails.map((m) => m.to)).toEqual(['alan@x.com']);
  });

  it('limita tentativas, vence em 15 minutos e um código novo anula o anterior', async () => {
    const t = await setup();
        await t.forgot('alan@x.com');
    const code = t.codeFrom(t.mails[0].text);
    const wrong = code === '000000' ? '111111' : '000000';

    const r1 = await t.reset(wrong);
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toContain('ainda tem 4 tentativas');
    for (let i = 0; i < 4; i++) await t.reset(wrong);
    // Esgotou: nem o certo vale mais.
    expect((await t.reset(code)).json().error).toContain('Peça um novo');

    // Pedido repetido em menos de 1 minuto não manda outro código.
    await t.forgot('alan@x.com');
    expect(t.mails).toHaveLength(1);

    await t.age();
    await t.forgot('alan@x.com');
    const first = t.codeFrom(t.mails[1].text);
    await t.age();
    await t.forgot('alan@x.com');
    const second = t.codeFrom(t.mails[2].text);
    if (first !== second) expect((await t.reset(first)).statusCode).toBe(400);

    await t.d.query(`update password_resets set expires_at = now() - interval '1 second'`);
    expect((await t.reset(second)).statusCode).toBe(400);
  });

  it('valida o formato e a nova senha', async () => {
    const t = await setup();
    expect((await t.forgot('nao-e-email')).statusCode).toBe(400);
    expect((await t.reset('12ab')).statusCode).toBe(400);
    const curta = await t.reset('123456', 'curta');
    expect(curta.statusCode).toBe(400);
    expect(JSON.stringify(curta.json())).toContain('8 caracteres');
  });

  it('sem e-mail configurado no servidor, avisa (mesmo com Telegram ligado)', async () => {
    const t = await setup({ email: false });
    await t.linkTelegram();
    const r = await t.forgot('alan@x.com');
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain('envio de e-mail');
    expect(t.tgSent).toEqual([]);
  });

  it('abrir o app renova a sessão', async () => {
    const t = await setup();
    const me = (await t.a.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${t.oldToken}` } })).json();
    expect(typeof me.token).toBe('string');
  });
});

describe('provedores de e-mail', () => {
  it('Brevo: remetente verificado, chave no cabeçalho api-key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length > 1
        ? new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 })
        : new Response('{"messageId":"x"}', { status: 201 });
    }) as typeof fetch;
    const m = createBrevoMailer('xkeysib-1', { email: 'alan@gmail.com', name: 'Saldo' }, f);
    await m.send({ to: 'alan@x.com', subject: 's', text: 't', html: '<p>t</p>' });
    expect(calls[0].url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((calls[0].init.headers as Record<string, string>)['api-key']).toBe('xkeysib-1');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      sender: { email: 'alan@gmail.com', name: 'Saldo' },
      to: [{ email: 'alan@x.com' }],
      subject: 's',
      textContent: 't',
      htmlContent: '<p>t</p>'
    });
    await expect(m.send({ to: 'x@y.com', subject: 's', text: 't' })).rejects.toThrow('Brevo: Key not found');
  });

  it('escolhe pelo ambiente', () => {
    expect(mailerFromEnv({})).toBeUndefined();
    expect(() => mailerFromEnv({ BREVO_API_KEY: 'k' })).toThrow('MAIL_FROM');
    expect(mailerFromEnv({ BREVO_API_KEY: 'k', MAIL_FROM: 'a@b.com' })).toBeDefined();
    expect(mailerFromEnv({ RESEND_API_KEY: 'k' })).toBeDefined();
  });
});

describe('Resend', () => {
  it('chama a API com a chave e entende o erro', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let fail = false;
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return fail ? new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 }) : new Response('{"id":"1"}');
    }) as typeof fetch;
    const m = createResendMailer('re_x', 'Saldo <a@b.com>', f);
    await m.send({ to: 'alan@x.com', subject: 's', text: 't' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer re_x');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: 'Saldo <a@b.com>', to: ['alan@x.com'], subject: 's', text: 't' });
    fail = true;
    await expect(m.send({ to: 'x@y.com', subject: 's', text: 't' })).rejects.toThrow('domain not verified');
  });
});
