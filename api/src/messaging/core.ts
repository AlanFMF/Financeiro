import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { HttpError } from '../server.js';
import type { Assistant, ChatMessage, ChatResult } from '../assistant/route.js';

/**
 * Núcleo do assistente por mensagem, igual para WhatsApp e Telegram:
 * - liga quem escreve a uma conta do Saldo por um código de 6 dígitos gerado em Ajustes;
 * - passa o texto ao mesmo assistente do app, com as últimas mensagens da conversa como contexto;
 * - guarda cada mensagem recebida pelo id do canal, para entrega repetida não lançar duas vezes.
 * Cada canal só traduz o formato dele (webhook, envio) para `IncomingChat` e `send`.
 */

export type Channel = 'whatsapp' | 'telegram';

export interface IncomingChat {
  /** Id único da mensagem no canal (trava contra entrega repetida). */
  id: string;
  /** Quem escreve: número do WhatsApp ou id do chat do Telegram. */
  from: string;
  /** Texto, ou null para áudio, foto etc. */
  text: string | null;
  kind: string;
  name?: string;
}

export interface ChatBotOptions {
  db: Db;
  channel: Channel;
  assistant: Assistant;
  send: (to: string, text: string) => Promise<void>;
  /** Outras formas do mesmo remetente (celular brasileiro com e sem o nono dígito). */
  aliases?: (from: string) => string[];
  /** Como o canal se chama nas mensagens ("WhatsApp", "Telegram"). */
  label: string;
}

export const CODE_TTL_MIN = 15;
const HISTORY_WINDOW_H = 3;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const reais = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const HELP = [
  'Oi! Eu lanço no seu Saldo. Mande do seu jeito:',
  '• gastei 45 no lanche',
  '• recebi 200 de pix do João',
  '• paguei 150 de luz ontem',
  '• quanto ainda posso gastar no mercado?',
  '• vou fechar o mês no azul?',
  '• apaga o último'
].join('\n');

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

// ------------------------------------------------------------ do lado do app (com login)

export async function createLinkCode(db: Db, userId: number, channel: Channel) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);
  await db.query(
    `insert into chat_codes (user_id, channel, code_hash, expires_at) values ($1, $2, $3, $4)
     on conflict (user_id, channel) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
    [userId, channel, hash(code), expiresAt.toISOString()]
  );
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function linkFor(db: Db, userId: number, channel: Channel) {
  return (
    await db.query<{ external_id: string; linked_at: string }>('select external_id, linked_at from chat_links where user_id = $1 and channel = $2', [
      userId,
      channel
    ])
  ).rows[0];
}

export async function unlink(db: Db, userId: number, channel: Channel) {
  await db.query('delete from chat_links where user_id = $1 and channel = $2', [userId, channel]);
}

// ------------------------------------------------------------ do lado do canal

export function createChatBot(opts: ChatBotOptions) {
  const { db, channel } = opts;
  const ids = (from: string) => [from, ...(opts.aliases?.(from) ?? [])];

  async function userFor(from: string): Promise<{ userId: number; name: string } | null> {
    const { rows } = await db.query<{ user_id: number; name: string }>(
      `select l.user_id, u.name from chat_links l join users u on u.id = l.user_id
       where l.channel = $1 and l.external_id = any($2::text[]) limit 1`,
      [channel, ids(from)]
    );
    return rows[0] ? { userId: rows[0].user_id, name: rows[0].name } : null;
  }

  async function say(to: string, userId: number | null, text: string) {
    await db.query(`insert into chat_messages (id, channel, external_id, user_id, role, content) values ($1, $2, $3, $4, 'assistant', $5)`, [
      `${channel}:out-${randomUUID()}`,
      channel,
      to,
      userId,
      text.slice(0, 4000)
    ]);
    await opts.send(to, text);
  }

  async function link(from: string, code: string, profileName?: string) {
    const { rows } = await db.query<{ user_id: number; name: string }>(
      `delete from chat_codes c using users u
       where u.id = c.user_id and c.channel = $1 and c.code_hash = $2 and c.expires_at > now()
       returning c.user_id, u.name`,
      [channel, hash(code)]
    );
    if (!rows[0]) {
      return say(from, null, `Esse código não vale (ou já passou de ${CODE_TTL_MIN} minutos). Gere outro em Ajustes → ${opts.label} e mande aqui.`);
    }
    const { user_id: userId, name } = rows[0];
    // Cada conta fica ligada a uma conversa por canal, e cada conversa a uma conta.
    await db.query('delete from chat_links where channel = $1 and (external_id = any($2::text[]) or user_id = $3)', [channel, ids(from), userId]);
    await db.query('insert into chat_links (user_id, channel, external_id) values ($1, $2, $3)', [userId, channel, from]);
    const first = (name || profileName || '').split(' ')[0];
    return say(from, userId, `Pronto${first ? `, ${first}` : ''}! Esta conversa está ligada ao seu Saldo.\n\n${HELP}`);
  }

  /** Trata uma mensagem recebida. Mensagem já vista é ignorada. */
  async function handle(msg: IncomingChat) {
    const text = (msg.text ?? '').trim().slice(0, 2000);
    const firstTime = (
      await db.query(
        `insert into chat_messages (id, channel, external_id, role, content) values ($1, $2, $3, 'user', $4)
         on conflict (id) do nothing returning id`,
        [`${channel}:${msg.id}`, channel, msg.from, text || `[${msg.kind}]`]
      )
    ).rows.length;
    if (!firstTime) return;

    const flat = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const codeMatch = flat.match(/^(?:\/start\s+|vincular\s+|conectar\s+|codigo\s+)?(\d{6})$/);
    if (codeMatch) return link(msg.from, codeMatch[1], msg.name);

    const user = await userFor(msg.from);
    if (!user) {
      return say(
        msg.from,
        null,
        `Oi! Para eu lançar no seu Saldo, primeiro ligue esta conversa à sua conta: no app, vá em Ajustes → ${opts.label}, toque em "Conectar ${opts.label}" e mande aqui o código que aparecer.`
      );
    }
    await db.query('update chat_messages set user_id = $2 where id = $1', [`${channel}:${msg.id}`, user.userId]);

    if (!text) return say(msg.from, user.userId, 'Por enquanto eu entendo só mensagens de texto. Escreva, por exemplo: gastei 45 no lanche.');
    if (/^\/?(ajuda|menu|help|start)$/.test(flat) || /^(oi|ola|bom dia|boa tarde|boa noite)[!.]?$/.test(flat)) {
      return say(msg.from, user.userId, `${HELP}\n\nTudo aparece na hora no app.`);
    }
    if (/^\/?(desvincular|desconectar|sair|stop)$/.test(flat)) {
      await unlink(db, user.userId, channel);
      return say(msg.from, null, `Pronto, desliguei esta conversa do seu Saldo. Para voltar, gere um código novo em Ajustes → ${opts.label}.`);
    }

    // Contexto: as últimas mensagens desta conversa nas últimas horas.
    const recent = (
      await db.query<ChatMessage>(
        `select role, content from chat_messages
         where channel = $1 and external_id = $2 and user_id = $3 and id <> $4
           and created_at > now() - ($5 || ' hours')::interval
         order by created_at desc limit 10`,
        [channel, msg.from, user.userId, `${channel}:${msg.id}`, String(HISTORY_WINDOW_H)]
      )
    ).rows.reverse();
    try {
      const result = await opts.assistant.converse(user.userId, [...recent, { role: 'user', content: text }]);
      await say(msg.from, user.userId, formatReply(result));
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'Não consegui lançar agora. Tente de novo em instantes ou use o app.';
      await say(msg.from, user.userId, message);
    }
  }

  return { handle };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Espera o processamento das mensagens recebidas pelos canais (usado nos testes). */
    chatIdle: () => Promise<void>;
  }
}
