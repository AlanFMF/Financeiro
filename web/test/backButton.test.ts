import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(), minimizeApp: vi.fn() } }));
// useBackHandler é um hook; aqui o teste usa o mesmo registro por baixo, simulando o efeito do React.
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>();
  return { ...real, useRef: (v: unknown) => ({ current: v }), useEffect: (fn: () => void) => fn() };
});

const { backAction, useBackHandler } = await import('../src/backButton');

describe('botão voltar do Android', () => {
  it('fecha primeiro a tela de cima e nunca encerra o app', () => {
    const closeChat = vi.fn();
    const closeSheet = vi.fn();
    useBackHandler(true, closeChat); // assistente aberto
    useBackHandler(true, closeSheet); // formulário aberto por cima dele

    expect(backAction({ pathname: '/', search: '' })).toEqual({ type: 'fechou' });
    expect(closeSheet).toHaveBeenCalledTimes(1);
    expect(closeChat).not.toHaveBeenCalled();
  });

  it('uma tela inativa não captura o voltar', () => {
    const handler = vi.fn();
    useBackHandler(false, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('sem nada aberto: de outra aba volta para o mês, mantendo o mês escolhido', async () => {
    vi.resetModules();
    const fresh = await import('../src/backButton');
    expect(fresh.backAction({ pathname: '/lancamentos', search: '?mes=2026-09' })).toEqual({ type: 'inicio', search: '?mes=2026-09' });
    expect(fresh.backAction({ pathname: '/ajustes', search: '' })).toEqual({ type: 'inicio', search: '' });
  });

  it('na tela do mês, manda o app para segundo plano em vez de fechar', async () => {
    vi.resetModules();
    const fresh = await import('../src/backButton');
    expect(fresh.backAction({ pathname: '/', search: '?mes=2026-10' })).toEqual({ type: 'minimizar' });
    expect(fresh.backAction({ pathname: '/login', search: '' })).toEqual({ type: 'minimizar' });
  });
});
