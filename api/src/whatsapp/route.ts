import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../server.js';
import type { Assistant } from '../assistant/route.js';
import { createChatBot, createLinkCode, linkFor, unlink } from '../messaging/core.js';
import { alternateBrazilNumber, type WhatsAppSender } from './client.js';

/**
 * Assistente pelo WhatsApp, com a Cloud API oficial da Meta.
 * A Meta chama POST /api/whatsapp/webhook a cada mensagem; a assinatura (X-Hub-Signature-256, HMAC do corpo
 * com o App Secret) é conferida antes de qualquer coisa. O resto (vínculo, assistente, contexto) é o núcleo
 * comum em messaging/core.ts.
 */

export interface WhatsAppOptions {
  enabled: boolean;
  verifyToken?: string;
  appSecret?: string;
  /** Número do assistente para mostrar no app e montar o link wa.me (ex.: "+1 555 010 9999"). */
  displayNumber?: string;
  sender?: WhatsAppSender;
  assistant: Assistant;
  /** Registra cada processamento em andamento (para app.chatIdle). */
  track: (work: Promise<unknown>) => void;
}

const digits = (s: string) => s.replace(/\D/g, '');

interface WebhookBody {
  entry?: {
    changes?: {
      value?: {
        messages?: { id: string; from: string; type: string; text?: { body?: string } }[];
        contacts?: { wa_id: string; profile?: { name?: string } }[];
      };
    }[];
  }[];
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

  const bot = opts.sender
    ? createChatBot({
        db: app.db,
        channel: 'whatsapp',
        label: 'WhatsApp',
        assistant: opts.assistant,
        send: (to, text) => opts.sender!.sendText(to, text),
        aliases: (from) => [alternateBrazilNumber(from)].filter(Boolean) as string[]
      })
    : null;

  const waLink = (text?: string) => {
    const n = opts.displayNumber ? digits(opts.displayNumber) : '';
    if (!n) return null;
    return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  };

  // ------------------------------------------------------------ no app (com login)

  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const link = await linkFor(app.db, req.user.sub, 'whatsapp');
    return {
      enabled: opts.enabled,
      number: opts.enabled ? (opts.displayNumber ?? null) : null,
      chatLink: opts.enabled ? waLink() : null,
      linked: link ? { number: `+${link.external_id.slice(0, 2)} •••• ${link.external_id.slice(-4)}`, linkedAt: link.linked_at } : null
    };
  });

  /** Gera o código que a pessoa manda para o assistente para ligar o número dela. */
  app.post('/code', { onRequest: [app.authenticate] }, async (req) => {
    if (!opts.enabled) throw new HttpError(503, 'O WhatsApp ainda não foi configurado neste servidor.');
    const r = await createLinkCode(app.db, req.user.sub, 'whatsapp');
    return { ...r, link: waLink(`vincular ${r.code}`) };
  });

  app.delete('/link', { onRequest: [app.authenticate] }, async (req, reply) => {
    await unlink(app.db, req.user.sub, 'whatsapp');
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
    if (!opts.enabled || !opts.appSecret || !bot) return reply.code(404).send();
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = `sha256=${createHmac('sha256', opts.appSecret).update(raw).digest('hex')}`;
    const ok = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!ok) return reply.code(401).send({ error: 'Assinatura inválida.' });

    // Responde já (a Meta reenvia se demorar) e processa em seguida.
    const body = req.body as WebhookBody;
    const work = (async () => {
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const names = new Map((change.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
          for (const m of change.value?.messages ?? []) {
            await bot.handle({
              id: m.id,
              from: digits(m.from),
              text: m.type === 'text' ? (m.text?.body ?? '') : null,
              kind: m.type,
              name: names.get(m.from)
            });
          }
        }
      }
    })().catch((err) => req.log.error({ err }, 'falha ao processar mensagem do WhatsApp'));
    opts.track(work);
    return reply.code(200).send({ ok: true });
  });
};
