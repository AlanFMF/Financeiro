import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Simula o plugin de voz do Android como ele se comporta de verdade:
 * - start() resolve na hora (modo de resultados parciais);
 * - stop() nunca resolve (o código nativo não chama resolve);
 * - parciais e o resultado final chegam pelo mesmo evento "partialResults";
 * - o fim da fala dispara "listeningState" com status "stopped".
 */
const listeners: Record<string, ((data: never) => void)[]> = {};
const fire = (event: string, data: unknown) => (listeners[event] ?? []).forEach((l) => l(data as never));
const plugin = {
  available: vi.fn(async () => ({ available: true })),
  checkPermissions: vi.fn(async () => ({ speechRecognition: 'granted' })),
  requestPermissions: vi.fn(async () => ({ speechRecognition: 'granted' })),
  start: vi.fn(async () => undefined),
  stop: vi.fn(() => new Promise(() => {})),
  isListening: vi.fn(async () => ({ listening: true })),
  addListener: vi.fn(async (event: string, cb: (data: never) => void) => {
    (listeners[event] ??= []).push(cb);
    return {
      remove: async () => {
        listeners[event] = listeners[event].filter((l) => l !== cb);
      }
    };
  })
};

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor-community/speech-recognition', () => ({ SpeechRecognition: plugin }));

const { startDictation } = await import('../src/speech');

describe('ditado no Android', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('devolve o texto ao soltar, mesmo com o stop() do plugin nunca respondendo', async () => {
    const updates: string[] = [];
    const session = await startDictation((t) => updates.push(t));
    fire('partialResults', { matches: ['gastei 50'] });
    fire('partialResults', { matches: ['gastei 50 no mercado'] });

    const done = session.stop();
    // o Android entrega o resultado final logo depois de parar
    fire('partialResults', { matches: ['gastei 50 no mercado hoje'] });
    await vi.advanceTimersByTimeAsync(0);

    await expect(done).resolves.toBe('gastei 50 no mercado hoje');
    expect(plugin.stop).toHaveBeenCalled();
    expect(updates.at(-1)).toBe('gastei 50 no mercado hoje');
  });

  it('se o resultado final não chegar, envia o último parcial', async () => {
    const session = await startDictation(() => {});
    fire('partialResults', { matches: ['recebi 200 de pix'] });
    const done = session.stop();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(done).resolves.toBe('recebi 200 de pix');
  });

  it('gravação travada junta os trechos entre as pausas e religa o reconhecimento', async () => {
    const session = await startDictation(() => {});
    expect(plugin.start).toHaveBeenCalledTimes(1);

    fire('partialResults', { matches: ['gastei 30 de uber'] });
    fire('listeningState', { status: 'stopped' }); // pausa na fala
    fire('partialResults', { matches: ['gastei 30 de uber'] }); // resultado final do trecho
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.start).toHaveBeenCalledTimes(2);

    fire('partialResults', { matches: ['e 20 de lanche'] });
    const done = session.stop();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(done).resolves.toBe('gastei 30 de uber e 20 de lanche');
  });

  it('cancelar descarta sem esperar o plugin', async () => {
    const session = await startDictation(() => {});
    fire('partialResults', { matches: ['isso não vai'] });
    session.cancel();
    expect(plugin.stop).toHaveBeenCalled();
    expect(listeners.partialResults).toHaveLength(0);
  });
});
