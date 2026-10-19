import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { alternateBrazilNumber, createWhatsAppSender } from '../src/whatsapp/client.js';

const SECRET = 'app-secret-de-teste';
const VERIFY = 'verifica-123';
const ALAN = '5534997794579';

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let sent: { to: string; body: string }[];
let headers: { authorization: string };

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
  sent = [];
  app = await buildApp({
    db,
    jwtSecret: 'test',
    rateLimit: false,
    assistant: { now: () => new Date('2026-10-18T15:00:00Z') },
    whatsapp: {
      verifyToken: VERIFY,
      appSecret: SECRET,
      displayNumber: '+1 555 010 9999',
      sender: { sendText: async (to, body) => void sent.push({ to, body }) }
    }
  });
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Alan Fabrício', email: 'alan@x.com', password: '12345678' } });
  headers = { authorization: `Bearer ${r.json().token}` };
});
afterEach(async () => {
  await app.close();
  await db.close();
});

let seq = 0;
function webhook(text: string, from = ALAN, opts: { id?: string; type?: string; secret?: string } = {}) {
  const id = opts.id ?? `wamid.${++seq}`;
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: from, profile: { name: 'Alan' } }],
              messages: [{ id, from, type: opts.type ?? 'text', ...(opts.type && opts.type !== 'text' ? {} : { text: { body: text } }) }]
            }
          }
        ]
      }
    ]
  });
  const signature = `sha256=${createHmac('sha256', opts.secret ?? SECRET).update(payload).digest('hex')}`;
  return app.inject({
    method: 'POST',
    url: '/api/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    payload
  });
}
async function send(text: string, from = ALAN, opts = {}) {
  const res = await webhook(text, from, opts);
  await app.chatIdle();
  return res;
}
const lastReply = () => (sent.at(-1)?.body ?? '').replace(/\u00a0/g, ' ');
const transactions = async () => (await app.inject({ method: 'GET', url: '/api/transactions', headers })).json().transactions;

async function linkAlan() {
  const { code } = (await app.inject({ method: 'POST', url: '/api/whatsapp/code', headers })).json();
  await send(`vincular ${code}`);
}

describe('WhatsApp', () => {
  it('confirma o webhook com o token certo', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=987` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('987');
    const bad = await app.inject({ method: 'GET', url: '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('recusa mensagem sem a assinatura da Meta', async () => {
    const res = await webhook('gastei 45 no lanche', ALAN, { secret: 'outro' });
    expect(res.statusCode).toBe(401);
    await app.chatIdle();
    expect(sent).toEqual([]);
  });

  it('número desconhecido recebe como ligar; com o código, liga e lança', async () => {
    await send('gastei 45 no lanche');
    expect(lastReply()).toContain('Ajustes → WhatsApp');
    expect(await transactions()).toEqual([]);

    const r = (await app.inject({ method: 'POST', url: '/api/whatsapp/code', headers })).json();
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.link).toBe(`https://wa.me/15550109999?text=vincular%20${r.code}`);
    await send(`Vincular ${r.code}`);
    expect(lastReply()).toMatch(/^Pronto, Alan! Esta conversa está ligada ao seu Saldo/);

    const status = (await app.inject({ method: 'GET', url: '/api/whatsapp', headers })).json();
    expect(status).toMatchObject({ enabled: true, linked: { number: '+55 •••• 4579' } });

    await send('gastei 45 no lanche');
    expect(lastReply()).toContain('Lancei R$ 45,00 em Alimentação');
    expect(lastReply()).toContain('apaga o último');
    const [t] = await transactions();
    expect(t).toMatchObject({ amountCents: 4500, categoryName: 'Alimentação', date: '2026-10-18' });
  });

  it('o código vale uma vez e expira', async () => {
    const { code } = (await app.inject({ method: 'POST', url: '/api/whatsapp/code', headers })).json();
    await db.query("update chat_codes set expires_at = now() - interval '1 minute'");
    await send(code);
    expect(lastReply()).toContain('Esse código não vale');
  });

  it('a mesma mensagem entregue duas vezes lança uma vez só', async () => {
    await linkAlan();
    await send('paguei 150 de luz', ALAN, { id: 'wamid.repetida' });
    await send('paguei 150 de luz', ALAN, { id: 'wamid.repetida' });
    expect(await transactions()).toHaveLength(1);
  });

  it('reconhece o número sem o nono dígito, responde metas e apaga o último', async () => {
    await linkAlan();
    await app.inject({ method: 'PUT', url: `/api/budgets/${(await transactionsCategory('Alimentação'))}`, headers, payload: { budgetCents: 100_00 } });
    await send('gastei 85 no mercado', '553497794579');
    expect(lastReply()).toContain('⚠️ Você já usou 85% da meta de Alimentação');
    await send('quanto ainda posso gastar no mercado?', '553497794579');
    expect(lastReply()).toContain('ainda pode gastar R$ 15,00');
    await send('apaga o último');
    expect(lastReply()).toContain('Apaguei o último lançamento');
    expect(await transactions()).toEqual([]);
  });

  it('áudio e outros tipos recebem uma explicação; "desvincular" desliga', async () => {
    await linkAlan();
    await send('', ALAN, { type: 'audio' });
    expect(lastReply()).toContain('só mensagens de texto');
    await send('desvincular');
    expect(lastReply()).toContain('desliguei esta conversa');
    await send('gastei 10 de café');
    expect(lastReply()).toContain('primeiro ligue esta conversa');
  });

  it('sem configuração, o webhook não existe e o app mostra que está desligado', async () => {
    const off = await buildApp({ db, jwtSecret: 'test', rateLimit: false });
    const r = await off.inject({ method: 'POST', url: '/api/whatsapp/webhook', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(404);
    const status = (await off.inject({ method: 'GET', url: '/api/whatsapp', headers })).json();
    expect(status).toMatchObject({ enabled: false, number: null });
    await off.close();
  });
});

async function transactionsCategory(name: string) {
  const cats = (await app.inject({ method: 'GET', url: '/api/categories', headers })).json().categories as { id: number; name: string }[];
  return cats.find((c) => c.name === name)!.id;
}

describe('envio pela Graph API', () => {
  it('formato alternativo do celular brasileiro', () => {
    expect(alternateBrazilNumber('5534997794579')).toBe('553497794579');
    expect(alternateBrazilNumber('553497794579')).toBe('5534997794579');
    expect(alternateBrazilNumber('15550109999')).toBeNull();
  });

  it('tenta o outro formato quando a Meta diz que o número não está na lista', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const to = JSON.parse(String(init.body)).to as string;
      calls.push(to);
      if (to === '5534997794579') return new Response(JSON.stringify({ error: { code: 131030, message: 'not in allowed list' } }), { status: 400 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const sender = createWhatsAppSender({ token: 't', phoneNumberId: '123' }, fakeFetch);
    await sender.sendText('5534997794579', 'oi');
    expect(calls).toEqual(['5534997794579', '553497794579']);
  });
});
