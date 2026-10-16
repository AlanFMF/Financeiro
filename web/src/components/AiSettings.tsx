import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

type ProviderId = 'claude' | 'openai' | 'gemini';

interface AiSettingsResponse {
  configured: boolean;
  provider: ProviderId | null;
  model: string | null;
  keyHint: string | null;
  providers: Record<ProviderId, { label: string; defaultModel: string; models: string[] }>;
}

/** O que muda de uma IA para outra, em palavras de quem vai usar. */
const GUIDE: Record<ProviderId, { where: string; url: string; note: string; placeholder: string }> = {
  claude: {
    where: 'console da Anthropic, em Settings, API keys',
    url: 'https://platform.claude.com',
    note: 'Cobrado por uso, à parte da assinatura do Claude. Cada mensagem custa frações de centavo no modelo padrão.',
    placeholder: 'sk-ant-…'
  },
  openai: {
    where: 'plataforma da OpenAI, em API keys',
    url: 'https://platform.openai.com/api-keys',
    note: 'Cobrado por uso, à parte do ChatGPT Plus: a assinatura do ChatGPT não inclui a API.',
    placeholder: 'sk-…'
  },
  gemini: {
    where: 'Google AI Studio, em Get API key',
    url: 'https://aistudio.google.com/apikey',
    note: 'Tem cota gratuita. No plano gratuito, o Google pode usar as conversas para melhorar os produtos dele.',
    placeholder: 'AIza…'
  }
};

const ORDER: ProviderId[] = ['gemini', 'claude', 'openai'];

export function AiSettings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['ai-settings'], queryFn: () => api.get<AiSettingsResponse>('/assistant/settings') });
  const [provider, setProvider] = useState<ProviderId>('gemini');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const data = settings.data;
  // Chegando pelo link "Conectar sua IA" do chat (/ajustes#ia), rola até aqui.
  useEffect(() => {
    if (data && window.location.hash === '#ia') document.getElementById('ia')?.scrollIntoView({ block: 'start' });
  }, [Boolean(data)]);
  useEffect(() => {
    if (data?.provider) {
      setProvider(data.provider);
      setModel(data.model ?? '');
    }
  }, [data?.provider, data?.model]);

  const refresh = (next?: AiSettingsResponse) => {
    if (next) qc.setQueryData(['ai-settings'], next);
    qc.invalidateQueries({ queryKey: ['assistant-status'] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.put<AiSettingsResponse>('/assistant/settings', {
        provider,
        apiKey: apiKey.trim() || undefined,
        model: model.trim() || undefined
      }),
    onSuccess: (next) => {
      refresh(next);
      setApiKey('');
      setEditing(false);
      setMessage({ ok: true, text: `${next.providers[next.provider!].label} conectado. O assistente já está usando a sua IA.` });
    },
    onError: (e) => setMessage({ ok: false, text: e instanceof ApiError ? e.message : 'Não foi possível conectar.' })
  });

  const disconnect = useMutation({
    mutationFn: () => api.del('/assistant/settings'),
    onSuccess: () => {
      qc.setQueryData<AiSettingsResponse>(['ai-settings'], (old) => old && { ...old, configured: false, provider: null, model: null, keyHint: null });
      refresh();
      setMessage({ ok: true, text: 'IA desconectada. O assistente voltou para o modo simples.' });
    }
  });

  if (!data) return <section className="panel" id="ia" aria-busy="true" />;

  const connected = data.configured && data.provider;
  const sameProvider = connected && data.provider === provider;
  const guide = GUIDE[provider];
  const info = data.providers[provider];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    save.mutate();
  };

  return (
    <section className="panel" id="ia">
      <h2>Assistente de IA</h2>

      {connected && !editing ? (
        <>
          <p className="ai-status">
            <span className="ai-dot" aria-hidden="true" />
            Conectado ao <strong>{data.providers[data.provider!].label}</strong>, modelo {data.model}, chave terminando em {data.keyHint}.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setEditing(true)}>
              Trocar IA ou modelo
            </button>
            <button className="btn ghost danger-text" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              Desconectar
            </button>
          </div>
        </>
      ) : (
        <form className="ai-form" onSubmit={submit}>
          <p className="muted">
            Conecte a sua própria conta de IA. Com ela, o assistente entende qualquer jeito de falar, corrige e apaga lançamentos e responde
            perguntas. Sem ela, ele funciona no modo simples, que entende frases diretas com o valor.
          </p>

          <div className="segmented three" role="radiogroup" aria-label="Qual IA">
            {ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={provider === id}
                className="seg"
                onClick={() => {
                  setProvider(id);
                  setModel(data.provider === id ? data.model ?? '' : '');
                  setMessage(null);
                }}
              >
                {data.providers[id].label}
              </button>
            ))}
          </div>

          <p className="note">
            Crie a chave no{' '}
            <a href={guide.url} target="_blank" rel="noreferrer">
              {guide.where}
            </a>
            . {guide.note}
          </p>

          <label className="field">
            <span>Chave de API{sameProvider ? ` (deixe em branco para manter a que termina em ${data.keyHint})` : ''}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={guide.placeholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>

          <label className="field">
            <span>Modelo</span>
            <input list={`modelos-${provider}`} placeholder={info.defaultModel} value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
            <datalist id={`modelos-${provider}`}>
              {info.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <small className="muted">Em branco usa o {info.defaultModel}, rápido e barato, que dá conta do recado. Os maiores entendem frases mais difíceis, mas custam mais.</small>
          </label>

          <p className="muted">A chave é testada antes de ser salva, fica criptografada no servidor e nunca volta para o aparelho.</p>

          <div className="actions">
            <button className="btn primary" disabled={save.isPending || (!apiKey.trim() && !sameProvider)}>
              {save.isPending ? 'Testando a chave…' : sameProvider && !apiKey.trim() ? 'Salvar modelo' : `Conectar ${info.label}`}
            </button>
            {connected && (
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                Cancelar
              </button>
            )}
          </div>
        </form>
      )}

      {message && (
        <p className={message.ok ? 'form-ok' : 'form-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
