import { useEffect, useState } from 'react';
import { BackgroundRunner } from '@capacitor/background-runner';
import { api, ApiError, isNativeApp, serverStore } from '../api';

const LABEL = 'io.github.alanfmf.saldo.notificacoes';
const STORE = 'saldo.notificacoes';

type State = { tokenId: number } | null;

function load(): State {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? 'null');
  } catch {
    return null;
  }
}
function save(s: State) {
  try {
    if (s) localStorage.setItem(STORE, JSON.stringify(s));
    else localStorage.removeItem(STORE);
  } catch {
    /* sem armazenamento */
  }
}

const dispatch = (event: string, details: Record<string, unknown> = {}) => BackgroundRunner.dispatchEvent({ label: LABEL, event, details });

/**
 * Notificações no celular (só no APK). Ao ativar: pede a permissão do Android, cria uma chave que só lê
 * /api/notifications e a entrega ao executor em segundo plano, que pergunta ao servidor a cada ~30 minutos.
 */
export function PhoneNotifications() {
  const [state, setState] = useState<State>(load);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [permission, setPermission] = useState<string | null>(null);

  useEffect(() => {
    if (!isNativeApp) return;
    BackgroundRunner.checkPermissions()
      .then((p) => setPermission(p.notifications))
      .catch(() => setPermission(null));
  }, []);

  if (!isNativeApp) return null;

  async function enable() {
    setBusy(true);
    setMessage(null);
    try {
      const p = await BackgroundRunner.requestPermissions({ apis: ['notifications'] });
      setPermission(p.notifications);
      if (p.notifications !== 'granted') {
        setMessage({ text: 'O Android não liberou as notificações. Libere em Configurações > Apps > Saldo > Notificações.', error: true });
        return;
      }
      const r = await api.post<{ token: string; info: { id: number } }>('/tokens', { name: 'Notificações do celular', scope: 'notify' });
      const server = serverStore.get() || window.location.origin;
      await dispatch('saldoConfigure', { server, token: r.token });
      // Primeira consulta já marca o ponto de partida; a de teste mostra que está tudo certo.
      await dispatch('saldoCheck');
      await dispatch('saldoTest');
      const s = { tokenId: r.info.id };
      save(s);
      setState(s);
      setMessage({ text: 'Pronto. Você deve ter recebido uma notificação de teste.' });
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : 'Não foi possível ativar as notificações.', error: true });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMessage(null);
    try {
      await dispatch('saldoDisable');
      if (state) await api.del(`/tokens/${state.tokenId}`).catch(() => {});
      save(null);
      setState(null);
      setMessage({ text: 'Notificações desligadas.' });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setMessage(null);
    try {
      await dispatch('saldoTest');
    } catch {
      setMessage({ text: 'Não consegui mostrar a notificação de teste.', error: true });
    }
  }

  const on = Boolean(state) && permission === 'granted';

  return (
    <section className="panel" id="notificacoes">
      <h2>Notificações no celular</h2>
      <p className="muted">
        Avisos quando uma meta chega a 80% ou é atingida e quando entram lançamentos do banco para conferir. O app confere de tempos em
        tempos, mesmo fechado. Alguns celulares atrasam esses avisos para economizar bateria.
      </p>
      {on ? (
        <div className="actions">
          <button className="btn" onClick={test} disabled={busy}>
            Enviar notificação de teste
          </button>
          <button className="btn ghost danger-text" onClick={disable} disabled={busy}>
            Desligar
          </button>
        </div>
      ) : (
        <button className="btn primary" onClick={enable} disabled={busy}>
          {busy ? 'Ativando…' : 'Ativar notificações'}
        </button>
      )}
      {message && (
        <p className={message.error ? 'form-error' : 'muted'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
