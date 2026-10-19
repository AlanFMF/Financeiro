import { EventEmitter } from 'node:events';

/**
 * Avisos em tempo real por usuário: "seus dados mudaram". O app escuta em /api/events e recarrega a tela.
 * Vale para qualquer origem de mudança: o próprio app em outro aparelho, Telegram, WhatsApp, Claude (MCP)
 * e a sincronização com o banco. Fica em memória: a API roda numa instância só.
 */

export interface DataChanged {
  /** De onde veio: id do aparelho que fez a mudança (o app ignora o próprio eco) ou o canal. */
  source: string;
  at: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

const key = (userId: number) => `user:${userId}`;

export function publishChange(userId: number, source: string) {
  bus.emit(key(userId), { source, at: new Date().toISOString() } satisfies DataChanged);
}

export function onChange(userId: number, fn: (e: DataChanged) => void) {
  bus.on(key(userId), fn);
  return () => bus.off(key(userId), fn);
}
