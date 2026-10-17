import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { App as NativeApp } from '@capacitor/app';
import { isNativeApp } from '../api';
import { flushOutbox, useOutbox } from '../outbox';
import { useEditor } from './Layout';
import { IconCloudOff } from './Icons';

const onlineStore = {
  get: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  subscribe(fn: () => void) {
    window.addEventListener('online', fn);
    window.addEventListener('offline', fn);
    return () => {
      window.removeEventListener('online', fn);
      window.removeEventListener('offline', fn);
    };
  }
};
export const useOnline = () => useSyncExternalStore(onlineStore.subscribe, onlineStore.get, onlineStore.get);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Faixa de "sem internet" e envio da fila: ao abrir o app, quando a conexão volta, quando o app volta
 * do segundo plano e, enquanto houver pendências, a cada 20 segundos.
 */
export function OfflineBar() {
  const qc = useQueryClient();
  const items = useOutbox();
  const online = useOnline();
  const { toast } = useEditor();

  const flush = useCallback(async () => {
    if (!navigator.onLine) return;
    const r = await flushOutbox(qc);
    if (r.failed.length) toast(r.failed[0]);
    else if (r.synced) toast(`${plural(r.synced, 'alteração feita sem internet foi salva', 'alterações feitas sem internet foram salvas')}`);
  }, [qc, toast]);

  useEffect(() => {
    flush();
    window.addEventListener('online', flush);
    const resume = isNativeApp ? NativeApp.addListener('resume', flush) : null;
    return () => {
      window.removeEventListener('online', flush);
      resume?.then((h) => h.remove()).catch(() => {});
    };
  }, [flush]);

  useEffect(() => {
    if (!items.length || !online) return;
    const t = setInterval(flush, 20_000);
    return () => clearInterval(t);
  }, [items.length, online, flush]);

  if (online && !items.length) return null;
  return (
    <p className="offline-bar" role="status">
      <IconCloudOff width={18} height={18} />
      <span>
        {!online && <strong>Sem internet. </strong>}
        {items.length
          ? `${plural(items.length, 'alteração esperando', 'alterações esperando')} para subir.`
          : 'Pode lançar normalmente: fica no aparelho e sobe quando a conexão voltar.'}
      </span>
      {online && items.length > 0 && (
        <button className="link-btn" onClick={flush}>
          Enviar agora
        </button>
      )}
    </p>
  );
}
