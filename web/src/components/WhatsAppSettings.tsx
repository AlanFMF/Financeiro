import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface Status {
  enabled: boolean;
  number: string | null;
  chatLink: string | null;
  linked: { number: string; linkedAt: string } | null;
}

/** Ajustes → WhatsApp: liga o número da pessoa ao assistente com um código de 6 dígitos. */
export function WhatsAppSettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['whatsapp'], queryFn: () => api.get<Status>('/whatsapp') });
  const [code, setCode] = useState<{ code: string; link: string | null; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createCode = useMutation({
    mutationFn: () => api.post<{ code: string; link: string | null; expiresAt: string }>('/whatsapp/code'),
    onSuccess: (r) => {
      setCode(r);
      setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível gerar o código.')
  });
  const unlink = useMutation({
    mutationFn: () => api.del('/whatsapp/link'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp'] })
  });

  const s = status.data;
  if (!s) return null;

  return (
    <section className="panel" id="whatsapp">
      <h2>WhatsApp</h2>
      {!s.enabled ? (
        <p className="muted">
          O assistente pelo WhatsApp ainda não foi configurado neste servidor. O passo a passo está no README do projeto, em "Assistente pelo
          WhatsApp".
        </p>
      ) : s.linked ? (
        <>
          <p className="muted">
            Seu número <strong>{s.linked.number}</strong> está ligado. Mande para o assistente "gastei 45 no lanche" e o lançamento aparece aqui
            na hora.
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
            Mande este código para o assistente{s.number ? ` (${s.number})` : ''} em até 15 minutos:
          </p>
          <code className="wa-code">{code.code}</code>
          <div className="actions">
            {code.link && (
              <a className="btn primary" href={code.link} target="_blank" rel="noreferrer">
                Abrir o WhatsApp com o código
              </a>
            )}
            <button
              className="btn ghost"
              onClick={() => {
                setCode(null);
                qc.invalidateQueries({ queryKey: ['whatsapp'] });
              }}
            >
              Já mandei
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted">
            Lance mandando mensagem no WhatsApp: "gastei 45 no lanche", "recebi 200 de pix", "quanto ainda posso gastar no mercado?". Usa a
            mesma IA (ou o modo simples) do assistente do app.
          </p>
          <button className="btn primary" onClick={() => createCode.mutate()} disabled={createCode.isPending}>
            {createCode.isPending ? 'Gerando…' : 'Conectar WhatsApp'}
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
