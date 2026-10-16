import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface TokenInfo {
  id: number;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'nunca';

/** Chaves que só servem para a tarefa agendada enviar os lançamentos do banco. */
export function SyncSettings() {
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: ['sync-tokens'],
    queryFn: () => api.get<{ tokens: TokenInfo[] }>('/tokens').then((r) => r.tokens)
  });
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ token: string; info: TokenInfo }>('/tokens', { name: 'Tarefa do Claude' }),
    onSuccess: (r) => {
      setCreated(r.token);
      setCopied(false);
      setError(null);
      qc.invalidateQueries({ queryKey: ['sync-tokens'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível criar a chave.')
  });

  const revoke = useMutation({
    mutationFn: (id: number) => api.del(`/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-tokens'] })
  });

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const list = tokens.data ?? [];

  return (
    <section className="panel" id="sincronizacao">
      <h2>Sincronização com o banco</h2>
      <p className="muted">
        Uma tarefa agendada no Claude lê o seu banco pelo Open Finance e envia os lançamentos para cá. Ela usa uma chave que só consegue enviar
        lançamentos do banco: não lê, não apaga e não muda mais nada na sua conta.
      </p>

      {created ? (
        <div className="token-box">
          <p>
            <strong>Copie a chave agora.</strong> Ela não aparece de novo. Cole na conversa com o Claude para ele montar a tarefa.
          </p>
          <code>{created}</code>
          <div className="actions">
            <button className="btn primary" onClick={copy}>
              {copied ? 'Copiada' : 'Copiar chave'}
            </button>
            <button className="btn ghost" onClick={() => setCreated(null)}>
              Já copiei
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Criando…' : 'Criar chave de sincronização'}
        </button>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list.length > 0 && (
        <ul className="token-list">
          {list.map((t) => (
            <li key={t.id}>
              <span>
                <span>
                  <strong>{t.name}</strong>, terminando em {t.hint}
                </span>
                <small className="muted">Último uso: {when(t.lastUsedAt)}</small>
              </span>
              <button className="link-btn danger-text" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending}>
                Revogar
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
