import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { App as NativeApp } from '@capacitor/app';
import { isNativeApp } from './api';

/**
 * Botão "voltar" do Android.
 *
 * Telas por cima do app (assistente, formulário de lançamento) se registram com useBackHandler; o voltar
 * fecha sempre a de cima. Sem nada aberto, ele volta para a tela do mês e, já nela, só manda o app para
 * segundo plano, como o botão de tela inicial — nunca encerra o app.
 */

type Entry = { current: () => void };
const stack: Entry[] = [];

/** Enquanto `active`, o voltar chama `handler` em vez de sair da tela. */
export function useBackHandler(active: boolean, handler: () => void) {
  const entry = useRef(handler);
  entry.current = handler;
  useEffect(() => {
    if (!active) return;
    const e = entry;
    stack.push(e);
    return () => {
      const i = stack.lastIndexOf(e);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** Fecha a tela de cima, se houver. Devolve se fechou alguma. */
export function handleBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.current();
  return true;
}

export type BackAction = { type: 'fechou' } | { type: 'inicio'; search: string } | { type: 'minimizar' };

/** Decide o que o voltar faz a partir da tela atual. */
export function backAction(location: { pathname: string; search: string }): BackAction {
  if (handleBack()) return { type: 'fechou' };
  if (location.pathname !== '/' && location.pathname !== '/login') {
    const mes = new URLSearchParams(location.search).get('mes');
    return { type: 'inicio', search: mes ? `?mes=${mes}` : '' };
  }
  return { type: 'minimizar' };
}

/** Liga o botão voltar do Android. Fica dentro do roteador. */
export function NativeBackButton() {
  const navigate = useNavigate();
  const location = useLocation();
  const where = useRef(location);
  where.current = location;

  useEffect(() => {
    if (!isNativeApp) return;
    const listener = NativeApp.addListener('backButton', () => {
      const action = backAction(where.current);
      if (action.type === 'inicio') navigate({ pathname: '/', search: action.search }, { replace: true });
      if (action.type === 'minimizar') NativeApp.minimizeApp().catch(() => {});
    });
    return () => {
      listener.then((l) => l.remove()).catch(() => {});
    };
  }, [navigate]);

  return null;
}
