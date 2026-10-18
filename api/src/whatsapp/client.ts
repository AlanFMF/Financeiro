/**
 * Envio de mensagens pela WhatsApp Cloud API (Graph API da Meta).
 *
 * Detalhe do Brasil: o WhatsApp às vezes entrega o número do celular sem o nono dígito
 * ("553497794579" em vez de "5534997794579"). No número de teste da Meta, o destinatário precisa estar
 * na lista exatamente como foi cadastrado; se a Meta recusar (erro 131030), tenta o outro formato.
 */

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  apiVersion?: string;
}

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
}

/** O outro formato do mesmo celular brasileiro (com ou sem o 9 depois do DDD); null se não se aplica. */
export function alternateBrazilNumber(waId: string): string | null {
  if (!/^55\d{10,11}$/.test(waId)) return null;
  if (waId.length === 13 && waId[4] === '9') return waId.slice(0, 4) + waId.slice(5);
  if (waId.length === 12 && /[6-9]/.test(waId[4])) return `${waId.slice(0, 4)}9${waId.slice(4)}`;
  return null;
}

export class WhatsAppError extends Error {
  constructor(public code: number | null, message: string) {
    super(message);
  }
}

export function createWhatsAppSender(cfg: WhatsAppConfig, fetchImpl: typeof fetch = fetch): WhatsAppSender {
  const url = `https://graph.facebook.com/${cfg.apiVersion ?? 'v23.0'}/${cfg.phoneNumberId}/messages`;

  async function send(to: string, body: string) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(0, 4000), preview_url: false } })
    });
    if (res.ok) return;
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
    throw new WhatsAppError(data.error?.code ?? null, data.error?.message ?? `HTTP ${res.status}`);
  }

  return {
    async sendText(to, body) {
      try {
        await send(to, body);
      } catch (err) {
        const alt = alternateBrazilNumber(to);
        if (err instanceof WhatsAppError && err.code === 131030 && alt) return send(alt, body);
        throw err;
      }
    }
  };
}
