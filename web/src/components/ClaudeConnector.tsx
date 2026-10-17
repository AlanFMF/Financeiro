import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, serverStore } from '../api';

interface TokenInfo {
  id: number;
  name: string;
  scope: 'sync' | 'mcp';
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'nunca';

/** Endereço do conector: o mesmo servidor da API, no caminho /mcp. */
export const connectorUrl = () => `${serverStore.get() || window.location.origin}/mcp`;

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <code>{value}</code>
      <button type="button" className="btn small" onClick={copy}>
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

/**
 * Conector personalizado do Claude: com ele, o Claude (no site, no computador ou no celular) lança e consulta
 * no Saldo usando a assinatura da pessoa. A chave só serve para o conector.
 */
export function ClaudeConnector() {
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: ['sync-tokens'],
    queryFn: () => api.get<{ tokens: TokenInfo[] }>('/tokens').then((r) => r.tokens)
  });
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>('/tokens', { name: 'Conector do Claude', scope: 'mcp' }),
    onSuccess: (r) => {
      setCreated(r.token);
      setError(null);
      qc.invalidateQueries({ queryKey: ['sync-tokens'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível criar a chave.')
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.del(`/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-tokens'] })
  });

  const list = (tokens.data ?? []).filter((t) => t.scope === 'mcp');

  return (
    <section className="panel" id="claude">
      <h2>Usar no Claude</h2>
      <p className="muted">
        Conecte o Saldo ao Claude e lance pelo app do Claude, no celular ou no computador: "gastei 45 no mercado", "quanto ainda posso
        gastar em lazer?". Usa a sua assinatura do Claude, sem custo de API. A chave só serve para o conector.
      </p>

      {created ? (
        <div className="token-box">
          <p>
            <strong>Copie a chave agora.</strong> Ela não aparece de novo.
          </p>
          <CopyField label="Endereço" value={connectorUrl()} />
          <CopyField label="Chave" value={created} />
          <ol className="steps">
            <li>
              No claude.ai, abra <strong>Personalizar → Conectores</strong>, toque em <strong>+</strong> e depois em{' '}
              <strong>Adicionar conector personalizado</strong>.
            </li>
            <li>
              Nome: <strong>Saldo</strong>. Em URL do servidor, cole o <strong>Endereço</strong>.
            </li>
            <li>
              Em autenticação, escolha <strong>Sem login</strong> e, nos cabeçalhos da requisição, adicione <code>Authorization</code> com o
              valor <code>Bearer</code> seguido de um espaço e da chave.
            </li>
            <li>
              Se não houver campo de cabeçalho, use como URL o endereço com a chave no fim: <code>…/mcp/</code> + chave.
            </li>
            <li>Numa conversa, ative o Saldo no botão + → Conectores e fale normalmente.</li>
          </ol>
          <button className="btn ghost" onClick={() => setCreated(null)}>
            Já configurei
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Criando…' : list.length ? 'Criar outra chave do conector' : 'Criar chave do conector'}
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
