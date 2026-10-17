import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { DictationFailure, dictationAvailable, startDictation, vibrate, withTimeout, type DictationSession } from './speech';

export type VoiceMode = 'idle' | 'holding' | 'locked';

/** Distâncias do gesto, em pixels: arrastar para cima trava; para a esquerda cancela. */
export const LOCK_DISTANCE = 70;
export const CANCEL_DISTANCE = 110;
const MIN_HOLD_MS = 450;

const NOTICES: Record<string, string> = {
  permissao: 'O microfone está bloqueado. Libere o acesso nas configurações para ditar.',
  liberado: 'Microfone liberado. Agora segure o botão para falar.',
  indisponivel: 'O reconhecimento de voz não está disponível neste aparelho.',
  falha: 'Não consegui ligar o microfone. Tente de novo.'
};

/**
 * Gravação por voz no estilo do WhatsApp:
 * - segure o microfone para falar e solte para enviar;
 * - arraste para cima para travar: continua ouvindo até tocar na seta;
 * - arraste para a esquerda para cancelar.
 */
export function useVoiceRecorder({ onSend, onNotice }: { onSend: (text: string) => void; onNotice: (text: string) => void }) {
  const [available, setAvailable] = useState(false);
  const [mode, setModeState] = useState<VoiceMode>('idle');
  const [text, setText] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [drag, setDrag] = useState({ x: 0, y: 0 });

  const modeRef = useRef<VoiceMode>('idle');
  const liveText = useRef('');
  const origin = useRef({ x: 0, y: 0, t: 0, id: -1 });
  const pending = useRef<Promise<DictationSession> | null>(null);
  const callbacks = useRef({ onSend, onNotice });
  callbacks.current = { onSend, onNotice };

  const setMode = (m: VoiceMode) => {
    modeRef.current = m;
    setModeState(m);
  };

  useEffect(() => {
    dictationAvailable().then(setAvailable);
  }, []);

  useEffect(() => {
    if (mode === 'idle') return;
    const t = setInterval(() => setElapsed(Date.now() - origin.current.t), 250);
    return () => clearInterval(t);
  }, [mode]);

  const finish = useCallback(async (send: boolean) => {
    if (modeRef.current === 'idle') return;
    setMode('idle');
    setDrag({ x: 0, y: 0 });
    const p = pending.current;
    pending.current = null;
    const session = await p?.catch(() => null);
    if (!session) return;
    if (!send) {
      session.cancel();
      return;
    }
    // O que já apareceu na tela vale como resposta se o reconhecimento não devolver nada a tempo.
    const shown = liveText.current;
    const result = ((await withTimeout(session.stop(), 4000, '')).trim() || shown).trim();
    if (result) callbacks.current.onSend(result);
    else callbacks.current.onNotice('Não ouvi nada. Segure o botão e fale.');
  }, []);

  const begin = (locked: boolean) => {
    setText('');
    liveText.current = '';
    setElapsed(0);
    setDrag({ x: 0, y: 0 });
    origin.current.t = Date.now();
    setMode(locked ? 'locked' : 'holding');
    vibrate();
    const p = startDictation((t) => {
      liveText.current = t;
      setText(t);
    });
    pending.current = p;
    p.catch((err) => {
      if (pending.current !== p) return;
      pending.current = null;
      setMode('idle');
      callbacks.current.onNotice(NOTICES[err instanceof DictationFailure ? err.reason : 'falha']);
    });
  };

  // Se o chat fechar no meio da gravação, descarta.
  useEffect(() => () => void pending.current?.then((s) => s.cancel()).catch(() => {}), []);

  const micProps = {
    onPointerDown(e: PointerEvent<HTMLButtonElement>) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (modeRef.current !== 'idle') return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      origin.current = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      begin(false);
    },
    onPointerMove(e: PointerEvent<HTMLButtonElement>) {
      if (modeRef.current !== 'holding' || e.pointerId !== origin.current.id) return;
      const x = Math.min(0, e.clientX - origin.current.x);
      const y = Math.min(0, e.clientY - origin.current.y);
      if (y < -LOCK_DISTANCE) {
        setMode('locked');
        setDrag({ x: 0, y: 0 });
        vibrate(35);
      } else if (x < -CANCEL_DISTANCE) {
        vibrate(50);
        finish(false);
        callbacks.current.onNotice('Gravação cancelada.');
      } else {
        // Só um eixo por vez, como no WhatsApp.
        setDrag(Math.abs(x) > Math.abs(y) ? { x, y: 0 } : { x: 0, y });
      }
    },
    onPointerUp(e: PointerEvent<HTMLButtonElement>) {
      if (modeRef.current !== 'holding' || e.pointerId !== origin.current.id) return;
      if (Date.now() - origin.current.t < MIN_HOLD_MS) {
        finish(false);
        callbacks.current.onNotice('Segure para falar e solte para enviar. Arraste para cima para gravar sem segurar.');
      } else finish(true);
    },
    onPointerCancel() {
      if (modeRef.current === 'holding') finish(false);
    },
    onContextMenu(e: { preventDefault: () => void }) {
      e.preventDefault();
    },
    /** Pelo teclado (Enter ou Espaço) a gravação já começa travada. */
    onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
      if ((e.key === 'Enter' || e.key === ' ') && modeRef.current === 'idle') {
        e.preventDefault();
        origin.current.t = Date.now();
        begin(true);
      }
    }
  };

  return {
    available,
    mode,
    text,
    elapsed,
    drag,
    micProps,
    send: () => finish(true),
    cancel: () => finish(false)
  };
}

export const formatElapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
