import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/server.js';

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
const sent: string[] = [];

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
  app = await buildApp({
    db,
    jwtSecret: 'test',
    rateLimit: false,
    assistant: { now: () => new Date('2026-10-19T15:00:00Z') },
    telegram: {
      client: { sendMessage: async (_to, text) => void sent.push(text), getMe: async () => ({ username: 'saldo_bot' }), setWebhook: async () => {} }
    }
  });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

async function register(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Alan', email, password: '12345678' } });
  const headers = { authorization: `Bearer ${r.json().token}` };
  const cats = (await app.inject({ method: 'GET', url: '/api/categories', headers })).json().categories as { id: number; name: string }[];
  return { headers, cat: (n: string) => cats.find((c) => c.name === n)!.id };
}

/** Abre /api/events como o app faz (fetch com Authorization) e junta os eventos recebidos. */
async function listen(headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
  const events: { event: string; data: { source?: string } }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : {} });
        }
      }
    } catch {
      /* fechado */
    }
  })();
  const waitFor = async (n: number) => {
    for (let t = 0; t < 100 && events.length < n; t++) await new Promise((r) => setTimeout(r, 20));
    return events;
  };
  return { status: res.status, contentType: res.headers.get('content-type'), events, waitFor, close: () => controller.abort() };
}

describe('avisos em tempo real', () => {
  it('avisa quando um lançamento muda, com a origem, e só para o dono', async () => {
    const alan = await register('alan@x.com');
    const outro = await register('outro@x.com');
    const sub = await listen(alan.headers);
    const subOutro = await listen(outro.headers);
    expect(sub.status).toBe(200);
    expect(sub.contentType).toContain('text/event-stream');
    await sub.waitFor(1);
    expect(sub.events[0].event).toBe('ready');

    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { ...alan.headers, 'x-client-id': 'celular-1' },
      payload: { categoryId: alan.cat('Alimentação'), date: '2026-10-19', description: 'Lanche', amountCents: 4500 }
    });
    const got = await sub.waitFor(2);
    expect(got[1]).toMatchObject({ event: 'changed', data: { source: 'celular-1' } });

    await subOutro.waitFor(1);
    expect(subOutro.events.map((e) => e.event)).toEqual(['ready']);

    // Leitura não avisa ninguém.
    await app.inject({ method: 'GET', url: '/api/transactions', headers: alan.headers });
    await new Promise((r) => setTimeout(r, 100));
    expect(sub.events).toHaveLength(2);
    sub.close();
    subOutro.close();
  });

  it('lançamento pelo Telegram também avisa o app aberto', async () => {
    const alan = await register('alan@x.com');
    const { code } = (await app.inject({ method: 'POST', url: '/api/telegram/code', headers: alan.headers })).json();
    const tg = (id: number, text: string) =>
      app.inject({
        method: 'POST',
        url: '/api/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': 'segredo-de-teste' },
        payload: { update_id: id, message: { message_id: id, chat: { id: 42, type: 'private' }, text } }
      });
    await tg(1, `/start ${code}`);
    await app.chatIdle();

    const sub = await listen(alan.headers);
    await sub.waitFor(1);
    await tg(2, 'gastei 45 no lanche');
    await app.chatIdle();
    const got = await sub.waitFor(2);
    expect(got[1]).toMatchObject({ event: 'changed', data: { source: 'telegram' } });
    sub.close();
  });

  it('sem login não abre', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
  });
});
