import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { SpeechRecognition as NativeSpeech } from '@capacitor-community/speech-recognition';

/**
 * Ditado por voz para o chat do assistente, com duas implementações:
 * - no APK, o reconhecimento de voz nativo do Android (plugin do Capacitor);
 * - no navegador, a Web Speech API.
 *
 * Os dois param sozinhos depois de um silêncio. Enquanto a sessão estiver ativa, o reconhecimento é religado
 * e os trechos vão sendo juntados, para a gravação "travada" (estilo WhatsApp) ouvir pelo tempo que for preciso.
 */

export interface DictationSession {
  /** Para de ouvir e devolve o texto final. */
  stop(): Promise<string>;
  /** Para de ouvir e descarta tudo. */
  cancel(): void;
}

/** permissao: o usuário negou o microfone; liberado: acabou de liberar (o toque atual é descartado). */
export type DictationError = 'permissao' | 'liberado' | 'indisponivel' | 'falha';

export class DictationFailure extends Error {
  constructor(public reason: DictationError) {
    super(reason);
  }
}

const LANG = 'pt-BR';
const FINAL_WAIT_MS = 700;
/** Quanto esperar pelo resultado final do Android depois que a fala termina ou o botão é solto. */
const NATIVE_FINAL_WAIT_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const join = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(' ');

/** Espera a promessa por no máximo `ms`; se ela falhar ou demorar, devolve `fallback`. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), sleep(ms).then(() => fallback)]);
}

// ------------------------------------------------------------------ APK (Android nativo)

async function nativeAvailable() {
  try {
    return (await NativeSpeech.available()).available;
  } catch {
    return false;
  }
}

async function nativeStart(onUpdate: (text: string) => void): Promise<DictationSession> {
  const perm = await NativeSpeech.checkPermissions();
  if (perm.speechRecognition !== 'granted') {
    // Pede a permissão e interrompe este toque: com o diálogo do Android na frente, o "segurar" se perde.
    const asked = await NativeSpeech.requestPermissions();
    throw new DictationFailure(asked.speechRecognition === 'granted' ? 'liberado' : 'permissao');
  }

  const committed: string[] = [];
  let partial = '';
  let active = true;
  let restarting = false;
  const handles: PluginListenerHandle[] = [];
  const emit = () => onUpdate(join([...committed, partial]));

  // O resultado final chega pelo mesmo evento dos parciais, um pouco depois do fim da fala.
  let resultWaiters: (() => void)[] = [];
  const nextResult = (ms: number) =>
    withTimeout(new Promise<void>((r) => resultWaiters.push(r)), ms, undefined);

  // start() só resolve de imediato no modo de resultados parciais; o limite evita travar se o Android não responder.
  const begin = () => withTimeout(NativeSpeech.start({ language: LANG, partialResults: true, popup: false, maxResults: 1 }), 3000, undefined);
  // stop() do plugin nunca responde no Android (falta o resolve no código nativo): nunca esperar por ele.
  const halt = () => void NativeSpeech.stop().catch(() => {});

  const commitAndRestart = async () => {
    if (restarting) return;
    restarting = true;
    await nextResult(NATIVE_FINAL_WAIT_MS);
    if (partial) committed.push(partial);
    partial = '';
    emit();
    if (active) await begin();
    restarting = false;
  };

  handles.push(
    await NativeSpeech.addListener('partialResults', (data) => {
      const best = data.matches?.[0];
      if (best) partial = best;
      emit();
      const waiters = resultWaiters;
      resultWaiters = [];
      waiters.forEach((w) => w());
    })
  );
  handles.push(
    await NativeSpeech.addListener('listeningState', (data) => {
      if (data.status === 'stopped' && active) commitAndRestart();
    })
  );

  // Erros como "nenhuma fala detectada" não avisam nada: um vigia religa se o reconhecimento parou sozinho.
  const watchdog = setInterval(async () => {
    if (!active || restarting) return;
    try {
      const { listening } = await NativeSpeech.isListening();
      if (!listening && active) commitAndRestart();
    } catch {
      /* ignora */
    }
  }, 1500);

  const removeListeners = () => handles.forEach((h) => void h.remove().catch(() => {}));
  const cleanup = () => {
    active = false;
    clearInterval(watchdog);
    halt();
  };

  await begin();

  return {
    async stop() {
      cleanup();
      // Se ainda estava ouvindo, o Android manda o texto final logo depois de parar.
      await nextResult(NATIVE_FINAL_WAIT_MS);
      removeListeners();
      return join([...committed, partial]);
    },
    cancel() {
      cleanup();
      removeListeners();
    }
  };
}

// ------------------------------------------------------------------ navegador (Web Speech API)

type WebRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

const WebCtor: (new () => WebRecognition) | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as Record<string, unknown>).SpeechRecognition as never) ??
      ((window as unknown as Record<string, unknown>).webkitSpeechRecognition as never)
    : undefined;

function webStart(onUpdate: (text: string) => void): Promise<DictationSession> {
  if (!WebCtor) return Promise.reject(new DictationFailure('indisponivel'));
  const committed: string[] = [];
  let partial = '';
  let active = true;
  let current: WebRecognition | null = null;
  let endedResolve: (() => void) | null = null;
  const emit = () => onUpdate(join([...committed, partial]));

  return new Promise((resolve, reject) => {
    let started = false;

    const spawn = () => {
      // continuous=false e uma instância por trecho: evita o defeito do Chrome no Android que repete palavras.
      const rec = new WebCtor();
      rec.lang = LANG;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const last = e.results[e.results.length - 1];
        partial = last[0].transcript;
        if (last.isFinal) {
          committed.push(partial);
          partial = '';
        }
        emit();
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          active = false;
          if (!started) reject(new DictationFailure('permissao'));
        }
      };
      rec.onend = () => {
        if (partial) committed.push(partial);
        partial = '';
        emit();
        if (active) spawn();
        else endedResolve?.();
      };
      current = rec;
      try {
        rec.start();
      } catch {
        if (!started) reject(new DictationFailure('falha'));
      }
    };

    spawn();
    started = true;
    resolve({
      async stop() {
        active = false;
        const ended = new Promise<void>((r) => (endedResolve = r));
        current?.stop();
        await Promise.race([ended, sleep(FINAL_WAIT_MS * 2)]);
        return join([...committed, partial]);
      },
      cancel() {
        active = false;
        current?.abort();
      }
    });
  });
}

// ------------------------------------------------------------------ escolha da implementação

export const isNative = Capacitor.isNativePlatform();

/** Se dá para ditar neste aparelho. */
export async function dictationAvailable(): Promise<boolean> {
  return isNative ? nativeAvailable() : Boolean(WebCtor);
}

export function startDictation(onUpdate: (text: string) => void): Promise<DictationSession> {
  return isNative ? nativeStart(onUpdate) : webStart(onUpdate);
}

export function vibrate(ms = 25) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* sem vibração */
  }
}
