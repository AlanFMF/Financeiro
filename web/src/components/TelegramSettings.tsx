import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface Status {
  enabled: boolean;
  bot: string | null;
  chatLink: string | null;
  linked: { linkedAt: string } | null;
}

/** Ajustes → Telegram: um toque abre o bot já com o código, e a conversa fica ligada à conta. */
export function TelegramSettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['telegram'], queryFn: () => api.get<Status>('/telegram') });
  const [code, setCode] = useState<{ code: string; link: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createCode = useMutation({
    mutationFn: () => api.post<{ code: string; link: string | null }>('/telegram/code'),
    onSuccess: (r) => {
      setCode(r);
      setError(null);
      // Abre o Telegram direto; o bot recebe "/start <código>" ao tocar em Começar.
      if (r.link) window.open(r.link, '_blank', 'noopener');
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível gerar o código.')
  });
  const unlink = useMutation({
    mutationFn: () => api.del('/telegram/link'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegram'] })
  });

  const s = status.data;
  if (!s) return null;

  return (
    <section className="panel" id="telegram">
      <h2>Telegram</h2>
      {!s.enabled ? (
        <p className="muted">
          O assistente pelo Telegram ainda não foi configurado neste servidor. O passo a passo está no README do projeto, em "Assistente pelo
          Telegram".
        </p>
      ) : s.linked ? (
        <>
          <p className="muted">
            Sua conversa com <strong>{s.bot}</strong> está ligada. Mande "gastei 45 no lanche" e o lançamento aparece aqui na hora.
          </p>
          <div className="actions">
            {s.chatLink && (
              <a className="btn primary" href={s.chatLink} target="_blank" rel="noreferrer">
                Abrir conversa
              </a>
            )}
            <button className="btn ghost danger-text" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
              Desconectar
            </button>
          </div>
        </>
      ) : code ? (
        <div className="token-box">
          <p>
            No Telegram, toque em <strong>Começar</strong> na conversa com {s.bot}. Se ela não abriu, use o botão abaixo ou mande o código para o
            bot em até 15 minutos:
          </p>
          <code className="wa-code">{code.code}</code>
          <div className="actions">
            {code.link && (
              <a className="btn primary" href={code.link} target="_blank" rel="noreferrer">
                Abrir o Telegram
              </a>
            )}
            <button
              className="btn ghost"
              onClick={() => {
                setCode(null);
                qc.invalidateQueries({ queryKey: ['telegram'] });
              }}
            >
              Já liguei
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted">
            Lance mandando mensagem para o bot do Saldo no Telegram: "gastei 45 no lanche", "recebi 200 de pix", "quanto ainda posso gastar no
            mercado?". Usa a mesma IA (ou o modo simples) do assistente do app.
          </p>
          <button className="btn primary" onClick={() => createCode.mutate()} disabled={createCode.isPending}>
            {createCode.isPending ? 'Gerando…' : 'Conectar Telegram'}
          </button>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
