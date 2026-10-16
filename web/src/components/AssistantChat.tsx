import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Transaction } from '../api';
import { dayLabel, money, todayIso } from '../format';
import { useInvalidate } from '../queries';
import { IconChat, IconClose, IconMic, IconSend } from './Icons';
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

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};
const SpeechRecognitionCtor: (new () => Recognition) | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as Record<string, unknown>).SpeechRecognition as never) ??
      ((window as unknown as Record<string, unknown>).webkitSpeechRecognition as never)
    : undefined;

export function AssistantChat({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [undone, setUndone] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const invalidate = useInvalidate();
  const editor = useEditor();

  const status = useQuery({
    queryKey: ['assistant-status'],
    queryFn: () => api.get<{ mode: 'ia' | 'simples' }>('/assistant/status'),
    staleTime: Infinity,
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
    else recognition.current?.stop();
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
    recognition.current?.stop();
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

  function toggleMic() {
    if (!SpeechRecognitionCtor) return;
    if (listening) return recognition.current?.stop();
    const rec = new SpeechRecognitionCtor();
    rec.lang = 'pt-BR';
    rec.interimResults = true;
    rec.continuous = false;
    const base = input ? `${input.trim()} ` : '';
    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join('');
      setInput(base + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognition.current = rec;
    setListening(true);
    rec.start();
  }

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
            <p>{simple ? 'Modo simples: diga o valor e o que foi' : 'Conte o que gastou ou recebeu, ou peça uma correção'}</p>
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

        <form className="chat-compose" onSubmit={submit}>
          <label className="sr-only" htmlFor="chat-input">
            Mensagem
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={input}
            maxLength={2000}
            placeholder={listening ? 'Ouvindo…' : 'Ex.: gastei 120 de gasolina ontem'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {SpeechRecognitionCtor && (
            <button
              type="button"
              className="icon-btn mic"
              data-listening={listening}
              aria-pressed={listening}
              aria-label={listening ? 'Parar de ouvir' : 'Falar'}
              onClick={toggleMic}
            >
              <IconMic />
            </button>
          )}
          <button type="submit" className="send-btn" aria-label="Enviar" disabled={!input.trim() || pending}>
            <IconSend />
          </button>
        </form>
      </section>
    </>
  );
}
