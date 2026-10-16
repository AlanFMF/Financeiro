import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Transaction } from '../api';
import { dayLabel, money, todayIso } from '../format';
import { useInvalidate } from '../queries';
import { IconChat, IconChevronUp, IconClose, IconLock, IconMic, IconSend, IconTrash } from './Icons';
import { CANCEL_DISTANCE, LOCK_DISTANCE, formatElapsed, useVoiceRecorder } from '../useVoiceRecorder';
import { useEditor } from './Layout';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  transactions?: Transaction[];
  updated?: Transaction[];
  deleted?: Transaction[];
  error?: boolean;
}

interface ChatResponse {
  reply: string;
  transactions: Transaction[];
  updated?: Transaction[];
  deleted?: Transaction[];
  mode: 'ia' | 'simples';
}

const STORAGE_KEY = 'saldo.chat';
const PROVIDER_LABEL = { claude: 'Claude', openai: 'ChatGPT', gemini: 'Gemini' } as const;
const SUGGESTIONS_IA = [
  'Mercado deu 230, mas 40 foi ração',
  'Comprei um tênis de 600 em 6x no cartão',
  'Quanto gastei com alimentação este mês?'
];
const SUGGESTIONS_SIMPLE = ['Gastei 45,90 no mercado ontem', 'Paguei 150 de condomínio e 300 de luz', 'Comprei um tênis de 600 em 6x'];

function loadHistory(): ChatMessage[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function AssistantChat({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [undone, setUndone] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const invalidate = useInvalidate();
  const editor = useEditor();
  const navigate = useNavigate();

  const status = useQuery({
    queryKey: ['assistant-status'],
    queryFn: () => api.get<{ mode: 'ia' | 'simples'; provider: 'claude' | 'openai' | 'gemini' | null }>('/assistant/status'),
    staleTime: 60_000,
    enabled: open
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      /* sem armazenamento: o histórico vive só nesta aba */
    }
  }, [messages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending, open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && !document.querySelector('dialog[open]') && onOpenChange(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;
    const userMsg: ChatMessage = { id: Date.now(), role: 'user', content };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setPending(true);
    try {
      const history = next.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
      const r = await api.post<ChatResponse>('/assistant/chat', { messages: history, today: todayIso() });
      setMessages((m) => [
        ...m,
        { id: Date.now() + 1, role: 'assistant', content: r.reply, transactions: r.transactions, updated: r.updated, deleted: r.deleted }
      ]);
      // Item apagado agora aparece riscado também no cartão da mensagem em que foi criado.
      if (r.deleted?.length) setUndone((s) => new Set([...s, ...r.deleted!.map((t) => t.id)]));
      if (r.transactions.length || r.updated?.length || r.deleted?.length) await invalidate();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Não consegui falar com o servidor.';
      setMessages((m) => [...m, { id: Date.now() + 1, role: 'assistant', content: msg, error: true }]);
    } finally {
      setPending(false);
    }
  }

  async function undo(tx: Transaction) {
    try {
      await api.del(`/transactions/${tx.id}`);
      setUndone((s) => new Set(s).add(tx.id));
      await invalidate();
    } catch (err) {
      editor.toast(err instanceof ApiError ? err.message : 'Não foi possível desfazer.');
    }
  }

  const voice = useVoiceRecorder({
    // Com uma resposta ainda chegando, o texto ditado vai para a caixa em vez de se perder.
    onSend: (text) => (pending ? setInput(text) : send(text)),
    onNotice: (text) => editor.toast(text)
  });
  const recording = voice.mode !== 'idle';
  const showMic = voice.available && (recording || !input.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const simple = status.data?.mode === 'simples';

  return (
    <>
      {!open && (
        <button className="chat-launcher" aria-label="Abrir assistente" onClick={() => onOpenChange(true)}>
          <IconChat />
          <span>Assistente</span>
        </button>
      )}

      <section className="chat-panel" data-open={open} role="dialog" aria-modal="false" aria-labelledby="chat-title" hidden={!open}>
        <header className="chat-head">
          <div>
            <h2 id="chat-title">Assistente</h2>
            <p>
              {simple ? (
                <>
                  Modo simples.{' '}
                  <button
                    className="link-btn inline"
                    onClick={() => {
                      onOpenChange(false);
                      navigate('/ajustes#ia');
                    }}
                  >
                    Conectar sua IA
                  </button>
                </>
              ) : (
                `Usando ${PROVIDER_LABEL[status.data?.provider ?? 'claude']}. Conte o que gastou ou recebeu.`
              )}
            </p>
          </div>
          {messages.length > 0 && (
            <button className="link-btn" onClick={() => setMessages([])}>
              Limpar
            </button>
          )}
          <button className="icon-btn" aria-label="Fechar assistente" onClick={() => onOpenChange(false)}>
            <IconClose />
          </button>
        </header>

        <div className="chat-log" ref={listRef} aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-empty">
              <p>
                Escreva do seu jeito, como numa conversa. Eu coloco cada valor na categoria certa e você pode desfazer na hora.
              </p>
              <div className="chat-suggestions">
                {(simple ? SUGGESTIONS_SIMPLE : SUGGESTIONS_IA).map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className={`bubble ${m.role}${m.error ? ' error' : ''}`}>
                <p>{m.content}</p>
                {[...(m.transactions ?? []), ...(m.updated ?? []), ...(m.deleted ?? [])].length > 0 && (
                  <ul className="chat-txs">
                    {m.deleted?.map((t) => (
                      <li key={`del-${t.id}`} data-undone="true">
                        <i className="dot" style={{ background: t.color }} aria-hidden="true" />
                        <span className="chat-tx-main">
                          <span className="tx-desc">{t.description || t.categoryName}</span>
                          <span className="tx-cat">
                            {t.categoryName}, {dayLabel(t.date)}
                          </span>
                        </span>
                        <span className={`tx-value tnum ${t.kind}`}>
                          {t.kind === 'entrada' ? '+' : '−'} {money(t.amountCents)}
                        </span>
                        <span className="chat-tx-actions">
                          <span className="tag">Excluído</span>
                        </span>
                      </li>
                    ))}
                    {[...(m.updated ?? []).map((t) => ({ t, changed: true })), ...(m.transactions ?? []).map((t) => ({ t, changed: false }))].map(({ t, changed }) => {
                      const isUndone = undone.has(t.id);
                      return (
                        <li key={t.id} data-undone={isUndone}>
                          <i className="dot" style={{ background: t.color }} aria-hidden="true" />
                          <span className="chat-tx-main">
                            <span className="tx-desc">{t.description || t.categoryName}</span>
                            <span className="tx-cat">
                              {t.categoryName}, {dayLabel(t.date)}
                            </span>
                          </span>
                          <span className={`tx-value tnum ${t.kind}`}>
                            {t.kind === 'entrada' ? '+' : '−'} {money(t.amountCents)}
                          </span>
                          <span className="chat-tx-actions">
                            {changed && !isUndone && <span className="tag">Corrigido</span>}
                            {isUndone ? (
                              <span className="muted">{changed ? 'Excluído' : 'Desfeito'}</span>
                            ) : (
                              <>
                                <button className="link-btn" onClick={() => editor.open(t)}>
                                  Editar
                                </button>
                                <button className="link-btn danger-text" onClick={() => undo(t)}>
                                  {changed ? 'Excluir' : 'Desfazer'}
                                </button>
                              </>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ))}

          {pending && (
            <div className="bubble-row assistant">
              <div className="bubble assistant typing" aria-label="Pensando">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>

        <form className="chat-compose" data-voice={voice.mode} onSubmit={submit}>
          {voice.mode === 'locked' && (
            <button key="trash" type="button" className="icon-btn rec-trash" aria-label="Descartar gravação" onClick={voice.cancel}>
              <IconTrash />
            </button>
          )}

          {recording ? (
            <div key="strip" className="rec-strip" role="status" aria-live="polite">
              <span className="rec-dot" aria-hidden="true" />
              <span className="rec-time tnum">{formatElapsed(voice.elapsed)}</span>
              <span className="rec-text">{voice.text ? (voice.text.length > 90 ? `…${voice.text.slice(-90)}` : voice.text) : 'Ouvindo…'}</span>
              {voice.mode === 'holding' && (
                <span
                  className="rec-cancel-hint"
                  style={{ opacity: 1 - Math.min(1, Math.abs(voice.drag.x) / CANCEL_DISTANCE), transform: `translateX(${voice.drag.x * 0.5}px)` }}
                >
                  ‹ Deslize para cancelar
                </span>
              )}
            </div>
          ) : (
            <>
              <label key="label" className="sr-only" htmlFor="chat-input">
                Mensagem
              </label>
              <textarea
                key="input"
                id="chat-input"
                ref={inputRef}
                rows={1}
                value={input}
                maxLength={2000}
                placeholder={voice.available ? 'Escreva ou segure o microfone' : 'Ex.: gastei 120 de gasolina ontem'}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </>
          )}

          {/* O mesmo botão do começo ao fim do gesto: trocar o elemento faria o navegador perder o dedo. */}
          {showMic && voice.mode !== 'locked' && (
            <div key="mic" className="mic-wrap" data-mode={voice.mode}>
              {voice.mode === 'holding' && (
                <span
                  className="lock-pill"
                  aria-hidden="true"
                  style={{ transform: `translateY(${Math.max(-LOCK_DISTANCE, voice.drag.y) * 0.6}px)` }}
                >
                  <IconLock />
                  <IconChevronUp />
                </span>
              )}
              <button
                type="button"
                className="mic-btn"
                aria-label="Segure para falar e solte para enviar. Arraste para cima para gravar sem segurar."
                style={voice.mode === 'holding' ? { transform: `translate(${voice.drag.x - 8}px, ${voice.drag.y}px) scale(1.35)` } : undefined}
                {...voice.micProps}
              >
                <IconMic />
              </button>
            </div>
          )}

          {voice.mode === 'locked' ? (
            <button key="send-voice" type="button" className="send-btn" aria-label="Enviar o que foi ditado" onClick={voice.send}>
              <IconSend />
            </button>
          ) : (
            !showMic && (
              <button key="send" type="submit" className="send-btn" aria-label="Enviar" disabled={!input.trim() || pending}>
                <IconSend />
              </button>
            )
          )}
        </form>
      </section>
    </>
  );
}
