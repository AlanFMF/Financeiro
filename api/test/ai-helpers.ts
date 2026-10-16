import { createPgliteDb, migrate } from '../src/db.js';
import { buildApp } from '../src/server.js';
import type { ChatMessage, ProviderConfig, ProviderFactory, ToolDef, ToolResult, Turn } from '../src/assistant/providers.js';

export interface Recorded {
  config: ProviderConfig;
  system: string;
  history: ChatMessage[];
  tools: ToolDef[];
  results: ToolResult[][];
}

/** IA falsa: cada conversa segue o roteiro de passos; guarda o que recebeu. */
export function scriptedProvider(steps: ((rec: Recorded) => Turn | Promise<Turn>)[]) {
  const sessions: Recorded[] = [];
  const factory: ProviderFactory = (config) => {
    const rec: Recorded = { config, system: '', history: [], tools: [], results: [] };
    sessions.push(rec);
    let i = 0;
    const next = () => {
      const step = steps[i++];
      if (!step) throw new Error('IA falsa sem roteiro para este passo');
      return Promise.resolve(step(rec));
    };
    return {
      start: (p) => {
        Object.assign(rec, p);
        return next();
      },
      continue: (r) => {
        rec.results.push(r);
        return next();
      }
    };
  };
  return { factory, sessions };
}

export const tool = (name: string, input: Record<string, unknown>): Turn => ({ text: '', toolCalls: [{ id: `call_${name}`, name, input }] });
export const say = (text: string): Turn => ({ text, toolCalls: [] });
export const lastResult = (rec: Recorded) => rec.results.at(-1)![0].content;

export const TODAY = '2026-10-16'; // sexta-feira

/** App com banco em memória, um usuário logado e, se `factory` vier, a IA dele conectada. */
export async function setupAi(factory?: ProviderFactory, verifyKey: (p: string, k: string) => Promise<void> = async () => {}) {
  const db = await createPgliteDb();
  await migrate(db);
  const app = await buildApp({
    db,
    jwtSecret: 'test',
    rateLimit: false,
    assistant: { ...(factory ? { providerFactory: factory } : {}), verifyKey }
  });
  const register = async (email: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'X', email, password: '12345678' } });
    return { authorization: `Bearer ${r.json().token}` };
  };
  const headers = await register('dono@x.com');
  if (factory) {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/assistant/settings',
      headers,
      payload: { provider: 'gemini', apiKey: 'AIza-chave-de-teste-1234' }
    });
    if (r.statusCode !== 200) throw new Error(`falha ao conectar IA: ${r.body}`);
  }
  const chat = (content: string, h = headers) =>
    app.inject({ method: 'POST', url: '/api/assistant/chat', headers: h, payload: { messages: [{ role: 'user', content }], today: TODAY } });
  const importCsv = (csv: string) => app.inject({ method: 'POST', url: '/api/import/csv', headers, payload: { csv, dryRun: false } });
  const list = async (h = headers) => (await app.inject({ method: 'GET', url: '/api/transactions', headers: h })).json().transactions;
  return { app, db, headers, register, chat, importCsv, list, close: async () => (await app.close(), await db.close()) };
}
