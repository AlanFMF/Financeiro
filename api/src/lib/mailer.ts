/** Envio de e-mail pela API HTTP do Resend (sem SMTP, sem dependência). Opcional: sem chave, o app não manda e-mail. */
export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export function createResendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send({ to, subject, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(`Resend: ${body.message ?? `HTTP ${res.status}`}`);
      }
    }
  };
}
