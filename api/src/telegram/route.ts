import type { FastifyPluginAsync } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { HttpError } from '../server.js';
import type { Assistant } from '../assistant/route.js';
import { createChatBot, createLinkCode, linkFor, unlink } from '../messaging/core.js';
import type { TelegramClient } from './client.js';

/**
 * Assistente pelo Telegram (Bot API oficial). O Telegram chama POST /api/telegram/webhook com o segredo no
 * cabeçalho X-Telegram-Bot-Api-Secret-Token; o resto (vínculo, assistente, contexto) é o núcleo comum.
 * O link t.me/<bot>?start=<código> abre a conversa e já manda "/start <código>", que liga a conta.
 */

export interface TelegramOptions {
  client?: TelegramClient;
  secret?: string;
  /** Nome do bot (@saldo_bot), descoberto no getMe ao iniciar. */
  username: () => string | null;
  assistant: Assistant;
  track: (work: Promise<unknown>) => void;
}

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { first_name?: string };
    text?: string;
    voice?: TgAudio;
    audio?: TgAudio;
    photo?: object;
  };
}

interface TgAudio {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const telegramRoutes: FastifyPluginAsync<TelegramOptions> = async (app, opts) => {
  const enabled = Boolean(opts.client && opts.secret);
  const bot = opts.client
    ? createChatBot({
        db: app.db,
        channel: 'telegram',
        label: 'Telegram',
        assistant: opts.assistant,
        hearsAudio: true,
        send: (to, text) => opts.client!.sendMessage(to, text)
      })
    : null;

  const botLink = (start?: string) => {
    const u = opts.username();
    return u ? `https://t.me/${u}${start ? `?start=${start}` : ''}` : null;
  };

  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const link = await linkFor(app.db, req.user.sub, 'telegram');
    return {
      enabled,
      bot: enabled && opts.username() ? `@${opts.username()}` : null,
      chatLink: enabled ? botLink() : null,
      linked: link ? { linkedAt: link.linked_at } : null,
      audio: enabled ? await opts.assistant.canTranscribe(req.user.sub) : false
    };
  });

  app.post('/code', { onRequest: [app.authenticate] }, async (req) => {
    if (!enabled) throw new HttpError(503, 'O Telegram ainda não foi configurado neste servidor.');
    const r = await createLinkCode(app.db, req.user.sub, 'telegram');
    return { ...r, link: botLink(r.code) };
  });

  app.delete('/link', { onRequest: [app.authenticate] }, async (req, reply) => {
    await unlink(app.db, req.user.sub, 'telegram');
    return reply.code(204).send();
  });

  app.post('/webhook', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!enabled || !bot) return reply.code(404).send();
    if (!safeEqual(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''), opts.secret!)) {
      return reply.code(401).send({ error: 'Segredo do webhook não confere.' });
    }
    const u = req.body as Update;
    const m = u.message;
    // Só conversas privadas com o bot: em grupo, qualquer pessoa poderia lançar na conta ligada.
    if (m && m.chat?.type === 'private') {
      const kind = m.text !== undefined ? 'text' : m.voice ? 'voice' : m.audio ? 'audio' : m.photo ? 'photo' : 'other';
      const clip = m.voice ?? m.audio;
      const audio = clip?.file_id
        ? {
            duration: clip.duration,
            size: clip.file_size,
            // Mensagem de voz do Telegram é OGG/Opus.
            load: async () => ({ data: await opts.client!.downloadFile(clip.file_id), mimeType: clip.mime_type || 'audio/ogg' })
          }
        : undefined;
      const work = bot
        .handle({ id: String(u.update_id), from: String(m.chat.id), text: m.text ?? null, kind, name: m.from?.first_name, audio })
        .catch((err) => req.log.error({ err }, 'falha ao processar mensagem do Telegram'));
      opts.track(work);
    }
    return reply.code(200).send({ ok: true });
  });
};
