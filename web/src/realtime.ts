import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiBase, CLIENT_ID, tokenStore } from './api';

/**
 * Tela sempre em dia: mantém aberto /api/events (Server-Sent Events) e, quando o servidor avisa que os dados
 * mudaram por outro caminho (Telegram, WhatsApp, Claude, banco, outro aparelho), recarrega o que está na tela.
 * Usa fetch em vez de EventSource para poder mandar o Authorization. Cai e volta sozinho.
 */

const KEYS = ['transactions', 'summary', 'history', 'categories', 'budgets', 'budget-alerts', 'review'];

function refresh(qc: QueryClient) {
  return Promise.all(KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

/** Lê um corpo text/event-stream e chama `onEvent` a cada bloco. */
async function readStream(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = /^event: ?(.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: ?(.*)$/m.exec(block)?.[1] ?? '';
      onEvent(event, data);
    }
  }
}

export function useRealtime(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let connectedBefore = false;
    let delay = 2000;
    // Cada conexão tem um número: uma conexão antiga, abortada, não agenda outra por conta própria.
    let generation = 0;

    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(qc), 300);
    };

    const connect = async () => {
      if (stopped) return;
      const mine = ++generation;
      const token = tokenStore.get();
      if (!token || (typeof navigator !== 'undefined' && navigator.onLine === false)) return retry();
      controller = new AbortController();
      try {
        const res = await fetch(`${apiBase()}/events`, {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'x-client-id': CLIENT_ID },
          signal: controller.signal,
          cache: 'no-store'
        });
        if (!res.ok || !res.body) return mine === generation && retry();
        await readStream(res.body, (event, data) => {
          if (event === 'ready') {
            delay = 2000;
            // Pode ter perdido avisos enquanto estava desconectado.
            if (connectedBefore) schedule();
            connectedBefore = true;
          } else if (event === 'changed') {
            try {
              if (JSON.parse(data).source === CLIENT_ID) return; // foi este aparelho que mudou
            } catch {
              /* aviso sem corpo: recarrega mesmo assim */
            }
            schedule();
          }
        });
        if (mine === generation) retry(); // o servidor fechou: reconecta
      } catch {
        if (!stopped && mine === generation) retry();
      }
    };

    function retry() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 60_000);
    }

    const reconnectNow = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      controller?.abort();
      if (timer) clearTimeout(timer);
      delay = 2000;
      void connect();
    };

    void connect();
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', reconnectNow);
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
      if (debounce) clearTimeout(debounce);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', reconnectNow);
    };
  }, [enabled, qc]);
}
