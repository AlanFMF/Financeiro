/**
 * Envio de e-mail por API HTTP (o Render gratuito bloqueia SMTP nas portas 25, 465 e 587).
 * - Brevo: plano grátis de 300 e-mails/dia e aceita como remetente um e-mail verificado, sem domínio próprio.
 * - Resend: precisa de domínio verificado para mandar para qualquer pessoa.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

async function failure(provider: string, res: Response) {
  const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
  return new Error(`${provider}: ${body.message ?? body.code ?? `HTTP ${res.status}`}`);
}

export function createBrevoMailer(apiKey: string, from: { email: string; name: string }, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send({ to, subject, text, html }) {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: from, to: [{ email: to }], subject, textContent: text, ...(html ? { htmlContent: html } : {}) }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) throw await failure('Brevo', res);
    }
  };
}

export function createResendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send({ to, subject, text, html }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) throw await failure('Resend', res);
    }
  };
}

/** Escolhe o provedor pelas variáveis de ambiente. Sem nenhuma chave, não há e-mail. */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer | undefined {
  const fromEmail = env.MAIL_FROM?.trim();
  const fromName = env.MAIL_FROM_NAME?.trim() || 'Saldo';
  if (env.BREVO_API_KEY) {
    if (!fromEmail) throw new Error('BREVO_API_KEY precisa de MAIL_FROM (o e-mail verificado como remetente no Brevo).');
    return createBrevoMailer(env.BREVO_API_KEY, { email: fromEmail, name: fromName });
  }
  if (env.RESEND_API_KEY) return createResendMailer(env.RESEND_API_KEY, fromEmail ? `${fromName} <${fromEmail}>` : 'Saldo <onboarding@resend.dev>');
  return undefined;
}
