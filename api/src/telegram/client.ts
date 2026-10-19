import { createHash } from 'node:crypto';

/** Chamadas à Bot API do Telegram que o Saldo usa. */
export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<void>;
  getMe(): Promise<{ username: string }>;
  setWebhook(url: string, secretToken: string): Promise<void>;
  /** Baixa um arquivo recebido (mensagem de voz, áudio) pelo file_id. */
  downloadFile(fileId: string): Promise<Buffer>;
}

export class TelegramError extends Error {}

export function createTelegramClient(token: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  const call = async <T>(method: string, body?: object): Promise<T> => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new TelegramError(data.description ?? `HTTP ${res.status}`);
    return data.result as T;
  };
  return {
    async sendMessage(chatId, text) {
      await call('sendMessage', { chat_id: chatId, text: text.slice(0, 4096), link_preview_options: { is_disabled: true } });
    },
    getMe: () => call<{ username: string }>('getMe'),
    async setWebhook(url, secretToken) {
      await call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'], drop_pending_updates: false });
    },
    async downloadFile(fileId) {
      const { file_path } = await call<{ file_path?: string }>('getFile', { file_id: fileId });
      if (!file_path) throw new TelegramError('arquivo indisponível');
      const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file_path}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new TelegramError(`download falhou: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
  };
}

/**
 * Segredo que o Telegram manda no cabeçalho X-Telegram-Bot-Api-Secret-Token de cada chamada do webhook.
 * Derivado do token do bot (que só o servidor conhece), então não precisa de outra variável.
 */
export const webhookSecret = (token: string) => createHash('sha256').update(`saldo-telegram:${token}`).digest('hex').slice(0, 48);
