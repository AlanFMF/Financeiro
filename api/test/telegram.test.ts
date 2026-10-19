import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createTelegramClient, webhookSecret } from '../src/telegram/client.js';

const CHAT = '987654321';
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let sent: { to: string; text: string }[];
let webhook: { url: string; secret: string } | null;
let headers: { authorization: string };

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
  sent = [];
  webhook = null;
  app = await buildApp({
    db,
    jwtSecret: 'test',
    rateLimit: false,
    assistant: { now: () => new Date('2026-10-19T15:00:00Z') },
    telegram: {
      publicUrl: 'https://saldo.example.com/',
      client: {
        sendMessage: async (to, text) => void sent.push({ to, text }),
        getMe: async () => ({ username: 'saldo_teste_bot' }),
        setWebhook: async (url, secret) => void (webhook = { url, secret }),
        downloadFile: async () => Buffer.from('ogg')
      }
    }
  });
  await app.ready();
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Alan Fabrício', email: 'alan@x.com', password: '12345678' } });
  headers = { authorization: `Bearer ${r.json().token}` };
});
afterEach(async () => {
  await app.close();
  await db.close();
});

let updateId = 1000;
async function send(text: string | null, opts: { chat?: string; type?: string; id?: number; secret?: string; extra?: object } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/telegram/webhook',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': opts.secret ?? 'segredo-de-teste' },
    payload: {
      update_id: opts.id ?? ++updateId,
      message: {
        message_id: 1,
        chat: { id: Number(opts.chat ?? CHAT), type: opts.type ?? 'private' },
        from: { first_name: 'Alan' },
        ...(text === null ? { voice: { file_id: 'x' } } : { text }),
        ...opts.extra
      }
    }
  });
  await app.chatIdle();
  return res;
}
const lastReply = () => (sent.at(-1)?.text ?? '').replace(/ /g, ' ');
const transactions = async () => (await app.inject({ method: 'GET', url: '/api/transactions', headers })).json().transactions;

describe('Telegram', () => {
  it('ao iniciar, descobre o bot e registra o webhook com o segredo', async () => {
    expect(webhook).toEqual({ url: 'https://saldo.example.com/api/telegram/webhook', secret: 'segredo-de-teste' });
    const status = (await app.inject({ method: 'GET', url: '/api/telegram', headers })).json();
    expect(status).toEqual({ enabled: true, bot: '@saldo_teste_bot', chatLink: 'https://t.me/saldo_teste_bot', linked: null, audio: false });
  });

  it('o link do código liga a conversa e os lançamentos entram', async () => {
    await send('gastei 45 no lanche');
    expect(lastReply()).toContain('Ajustes → Telegram');

    const { code, link } = (await app.inject({ method: 'POST', url: '/api/telegram/code', headers })).json();
    expect(link).toBe(`https://t.me/saldo_teste_bot?start=${code}`);
    await send(`/start ${code}`);
    expect(lastReply()).toMatch(/^Pronto, Alan! Esta conversa está ligada ao seu Saldo/);
    expect(sent.at(-1)!.to).toBe(CHAT);

    await send('gastei 45 no lanche e 12 de uber ontem');
    expect(lastReply()).toContain('Lancei R$ 45,00 em Alimentação e R$ 12,00 em Transporte');
    expect((await transactions()).map((t: { date: string }) => t.date)).toEqual(['2026-10-18', '2026-10-18']);
    expect((await app.inject({ method: 'GET', url: '/api/telegram', headers })).json().linked).not.toBeNull();
  });

  it('recusa chamada sem o segredo, ignora grupos e repetições', async () => {
    expect((await send('oi', { secret: 'errado' })).statusCode).toBe(401);
    const { code } = (await app.inject({ method: 'POST', url: '/api/telegram/code', headers })).json();
    await send(code);
    sent = [];
    await send('gastei 50 no mercado', { type: 'group' });
    expect(sent).toEqual([]);
    await send('paguei 150 de luz', { id: 5555 });
    await send('paguei 150 de luz', { id: 5555 });
    expect(await transactions()).toHaveLength(1);
  });

  it('áudio sem IA que ouve explica como ligar; /stop desliga', async () => {
    const { code } = (await app.inject({ method: 'POST', url: '/api/telegram/code', headers })).json();
    await send(`/start ${code}`);
    expect(lastReply()).toContain('Escreva ou mande áudio');
    await send(null);
    expect(lastReply()).toContain('conecte o Gemini');
    await send('/start');
    expect(lastReply()).toContain('gastei 45 no lanche');
    await send('/stop');
    expect(lastReply()).toContain('desliguei esta conversa');
    expect((await app.inject({ method: 'GET', url: '/api/telegram', headers })).json().linked).toBeNull();
  });

  it('o código do Telegram liga só a conversa do Telegram', async () => {
    const tg = (await app.inject({ method: 'POST', url: '/api/telegram/code', headers })).json().code;
    await send(tg);
    // Código do Telegram não vale em outro canal e vice-versa: só existe para o canal que o gerou.
    const row = (await db.query<{ n: number }>("select count(*)::int as n from chat_links where channel = 'telegram'")).rows[0];
    expect(row.n).toBe(1);
  });
});

describe('Bot API', () => {
  it('chama os métodos certos e entende os erros', async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const method = url.split('/').at(-1)!;
      calls.push({ method, body: JSON.parse(String(init.body)) });
      if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { username: 'saldo_bot' } }));
      if (method === 'sendMessage' && calls.length > 2) return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), { status: 403 });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as typeof fetch;
    const c = createTelegramClient('123:abc', fakeFetch);
    expect((await c.getMe()).username).toBe('saldo_bot');
    await c.setWebhook('https://x/api/telegram/webhook', 's');
    expect(calls[1].body).toMatchObject({ url: 'https://x/api/telegram/webhook', secret_token: 's', allowed_updates: ['message'] });
    await expect(c.sendMessage('1', 'oi')).rejects.toThrow('Forbidden: bot was blocked');
    expect(webhookSecret('123:abc')).toMatch(/^[0-9a-f]{48}$/);
    expect(webhookSecret('123:abc')).not.toBe(webhookSecret('123:abd'));
  });
});
