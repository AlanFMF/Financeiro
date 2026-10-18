import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../server.js';
import type { Assistant, ChatMessage, ChatResult } from '../assistant/route.js';
import { alternateBrazilNumber, type WhatsAppSender } from './client.js';

/**
 * Assistente pelo WhatsApp, com a Cloud API oficial da Meta.
 *
 * - A Meta chama POST /api/whatsapp/webhook a cada mensagem recebida. A assinatura (X-Hub-Signature-256,
 *   HMAC do corpo com o App Secret) é conferida antes de qualquer coisa.
 * - O número de quem escreve é ligado a uma conta por um código de 6 dígitos gerado em Ajustes.
 * - O texto vai para o mesmo assistente do app (IA do usuário ou modo simples), com as últimas mensagens
 *   da conversa como contexto, e a resposta volta pelo WhatsApp.
 * - O id da mensagem da Meta é chave primária: entrega repetida não lança duas vezes.
 */

export interface WhatsAppOptions {
  enabled: boolean;
  verifyToken?: string;
  appSecret?: string;
  /** Número do assistente para mostrar no app e montar o link wa.me (ex.: "+1 555 010 9999"). */
  displayNumber?: string;
  sender?: WhatsAppSender;
  assistant: Assistant;
  /** Registra cada processamento em andamento (para app.whatsappIdle). */
  track: (work: Promise<unknown>) => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Espera o processamento das mensagens recebidas (usado nos testes). */
    whatsappIdle: () => Promise<void>;
  }
}

const CODE_TTL_MIN = 15;
const HISTORY_WINDOW_H = 3;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const digits = (s: string) => s.replace(/\D/g, '');

const HELP = [
  'Oi! Eu lanço no seu Saldo. Mande do seu jeito:',
  '• gastei 45 no lanche',
  '• recebi 200 de pix do João',
  '• paguei 150 de luz ontem',
  '• quanto ainda posso gastar no mercado?',
  '• vou fechar o mês no azul?',
  '• apaga o último'
].join('\n');

interface IncomingMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
}

interface WebhookBody {
  object?: string;
  entry?: { changes?: { value?: { messages?: IncomingMessage[]; contacts?: { wa_id: string; profile?: { name?: string } }[] } }[] }[];
}

const reais = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Texto da resposta: a frase do assistente, os avisos de meta e, se lançou algo, como desfazer. */
export function formatReply(r: ChatResult): string {
  const lines = [r.reply.trim()];
  const touched = r.transactions.length + (r.updated?.length ?? 0);
  if (r.mode === 'ia' && r.transactions.length) {
    lines.push(r.transactions.map((t) => `• ${t.description || t.categoryName}: ${reais(t.amountCents)} em ${t.categoryName}`).join('\n'));
  }
  for (const a of r.alerts ?? []) lines.push(`⚠️ ${a.message}`);
  if (touched) lines.push('Errou? Mande "apaga o último" ou corrija ("na verdade foi 50").');
  return lines.filter(Boolean).join('\n\n');
}

export const whatsappRoutes: FastifyPluginAsync<WhatsAppOptions> = async (app, opts) => {
  // O corpo bruto é necessário para conferir a assinatura da Meta.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  const waLink = (text?: string) => {
    const n = opts.displayNumber ? digits(opts.displayNumber) : '';
    if (!n) return null;
    return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  };

  // ------------------------------------------------------------ no app (com login)

  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const link = (await app.db.query<{ wa_id: string; linked_at: string }>('select wa_id, linked_at from whatsapp_links where user_id = $1', [req.user.sub])).rows[0];
    return {
      enabled: opts.enabled,
      number: opts.enabled ? (opts.displayNumber ?? null) : null,
      chatLink: opts.enabled ? waLink() : null,
      linked: link ? { number: `+${link.wa_id.slice(0, 2)} •••• ${link.wa_id.slice(-4)}`, linkedAt: link.linked_at } : null
    };
  });

  /** Gera o código que a pessoa manda para o assistente para ligar o número dela. */
  app.post('/code', { onRequest: [app.authenticate] }, async (req) => {
    if (!opts.enabled) throw new HttpError(503, 'O WhatsApp ainda não foi configurado neste servidor.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);
    await app.db.query(
      `insert into whatsapp_codes (user_id, code_hash, expires_at) values ($1, $2, $3)
       on conflict (user_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
      [req.user.sub, hash(code), expiresAt.toISOString()]
    );
    return { code, expiresAt: expiresAt.toISOString(), link: waLink(`vincular ${code}`) };
  });

  app.delete('/link', { onRequest: [app.authenticate] }, async (req, reply) => {
    await app.db.query('delete from whatsapp_links where user_id = $1', [req.user.sub]);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ webhook da Meta (sem login, com assinatura)

  /** Verificação do endereço quando ele é cadastrado no painel da Meta. */
  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!opts.enabled || !opts.verifyToken) return reply.code(404).send();
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === opts.verifyToken) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send({ error: 'Token de verificação não confere.' });
  });

  app.post('/webhook', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!opts.enabled || !opts.appSecret || !opts.sender) return reply.code(404).send();
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = `sha256=${createHmac('sha256', opts.appSecret).update(raw).digest('hex')}`;
    const ok = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!ok) return reply.code(401).send({ error: 'Assinatura inválida.' });

    // Responde já (a Meta reenvia se demorar) e processa em seguida.
    const body = req.body as WebhookBody;
    const work = handleWebhook(body).catch((err) => req.log.error({ err }, 'falha ao processar mensagem do WhatsApp'));
    opts.track(work);
    return reply.code(200).send({ ok: true });
  });

  async function handleWebhook(body: WebhookBody) {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const names = new Map((change.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const msg of change.value?.messages ?? []) await handleMessage(msg, names.get(msg.from));
      }
    }
  }

  async function userFor(waId: string): Promise<{ userId: number; name: string } | null> {
    const candidates = [waId, alternateBrazilNumber(waId)].filter(Boolean) as string[];
    const { rows } = await app.db.query<{ user_id: number; name: string }>(
      `select l.user_id, u.name from whatsapp_links l join users u on u.id = l.user_id where l.wa_id = any($1::text[]) limit 1`,
      [candidates]
    );
    return rows[0] ? { userId: rows[0].user_id, name: rows[0].name } : null;
  }

  async function say(waId: string, userId: number | null, text: string) {
    await app.db.query(`insert into whatsapp_messages (id, wa_id, user_id, role, content) values ($1, $2, $3, 'assistant', $4)`, [
      `out-${randomUUID()}`,
      waId,
      userId,
      text.slice(0, 4000)
    ]);
    await opts.sender!.sendText(waId, text);
  }

  async function handleMessage(msg: IncomingMessage, profileName?: string) {
    const waId = digits(msg.from);
    const text = msg.type === 'text' ? (msg.text?.body ?? '').trim().slice(0, 2000) : '';
    const firstTime = (
      await app.db.query(
        `insert into whatsapp_messages (id, wa_id, role, content) values ($1, $2, 'user', $3) on conflict (id) do nothing returning id`,
        [msg.id, waId, text || `[${msg.type}]`]
      )
    ).rows.length;
    if (!firstTime) return; // a Meta entregou de novo

    const flat = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const codeMatch = flat.match(/^(?:vincular|conectar|codigo)?\s*(\d{6})$/);
    if (codeMatch) return link(waId, codeMatch[1], profileName);

    const user = await userFor(waId);
    if (!user) {
      return say(
        waId,
        null,
        'Oi! Para eu lançar no seu Saldo, primeiro ligue este número à sua conta: no app, vá em Ajustes → WhatsApp, toque em "Conectar WhatsApp" e mande aqui o código que aparecer (por exemplo: vincular 123456).'
      );
    }
    await app.db.query('update whatsapp_messages set user_id = $2 where id = $1', [msg.id, user.userId]);

    if (!text) return say(waId, user.userId, 'Por enquanto eu entendo só mensagens de texto. Escreva, por exemplo: gastei 45 no lanche.');
    if (/^(ajuda|menu|help|\?)$/.test(flat) || /^(oi|ola|bom dia|boa tarde|boa noite)[!.]?$/.test(flat)) {
      return say(waId, user.userId, `${HELP}\n\nTudo aparece na hora no app.`);
    }
    if (/^(desvincular|desconectar|sair)$/.test(flat)) {
      await app.db.query('delete from whatsapp_links where user_id = $1', [user.userId]);
      return say(waId, null, 'Pronto, desliguei este número do seu Saldo. Para voltar, gere um código novo em Ajustes → WhatsApp.');
    }

    // Contexto: as últimas mensagens desta conversa nas últimas horas.
    const recent = (
      await app.db.query<ChatMessage>(
        `select role, content from whatsapp_messages
         where wa_id = $1 and user_id = $2 and id <> $3 and created_at > now() - ($4 || ' hours')::interval
         order by created_at desc limit 10`,
        [waId, user.userId, msg.id, String(HISTORY_WINDOW_H)]
      )
    ).rows.reverse();
    try {
      const result = await opts.assistant.converse(user.userId, [...recent, { role: 'user', content: text }]);
      await say(waId, user.userId, formatReply(result));
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'Não consegui lançar agora. Tente de novo em instantes ou use o app.';
      await say(waId, user.userId, message);
    }
  }

  async function link(waId: string, code: string, profileName?: string) {
    const { rows } = await app.db.query<{ user_id: number; name: string }>(
      `delete from whatsapp_codes c using users u
       where u.id = c.user_id and c.code_hash = $1 and c.expires_at > now()
       returning c.user_id, u.name`,
      [hash(code)]
    );
    if (!rows[0]) {
      return say(waId, null, 'Esse código não vale (ou já passou de 15 minutos). Gere outro em Ajustes → WhatsApp e mande aqui.');
    }
    const { user_id: userId, name } = rows[0];
    // Um número fica ligado a uma conta só, e cada conta a um número.
    await app.db.query('delete from whatsapp_links where wa_id = $1 or user_id = $2', [waId, userId]);
    await app.db.query('insert into whatsapp_links (user_id, wa_id) values ($1, $2)', [userId, waId]);
    const first = (name || profileName || '').split(' ')[0];
    return say(waId, userId, `Pronto${first ? `, ${first}` : ''}! Este número está ligado ao seu Saldo.\n\n${HELP}`);
  }
};
