import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let user: Awaited<ReturnType<typeof ctx.register>>;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

beforeEach(async () => {
  ctx = await setup();
  user = await ctx.register('notif@x.com');
});
afterEach(() => ctx.close());

const key = async (scope: 'sync' | 'notify') =>
  (await ctx.app.inject({ method: 'POST', url: '/api/tokens', headers: user.headers, payload: { name: scope, scope } })).json().token as string;
const poll = async (token: string) => ctx.app.inject({ method: 'GET', url: '/api/notifications', headers: { authorization: `Bearer ${token}` } });
const sync = (token: string, items: object[]) =>
  ctx.app.inject({ method: 'POST', url: '/api/sync/bank', headers: { authorization: `Bearer ${token}` }, payload: { source: 'Nubank conta', items } });
const item = (externalId: string, amountCents: number, kind = 'saida') => ({
  externalId,
  date: today(),
  amountCents,
  kind,
  description: kind === 'saida' ? 'Compra no débito|Padaria' : 'Transferência Recebida|Fulano',
  bankCategory: kind === 'saida' ? 'Groceries' : 'Transfers'
});

describe('notificações do celular', () => {
  it('avisa uma vez o que entrou do banco e as metas, e depois fica quieto', async () => {
    const notify = await key('notify');
    const syncKey = await key('sync');
    expect((await poll(notify)).json().notifications).toEqual([]); // primeira chamada marca o ponto de partida

    await ctx.app.inject({ method: 'PUT', url: `/api/budgets/${user.cat('Alimentação')}`, headers: user.headers, payload: { budgetCents: 100_00 } });
    await sync(syncKey, [item('a', 45_00), item('b', 40_00), item('c', 61_33, 'entrada')]);

    const list = (await poll(notify)).json().notifications as { title: string; body: string; kind: string; id: number }[];
    expect(list.map((n) => n.kind).sort()).toEqual(['importados', 'meta']);
    const imp = list.find((n) => n.kind === 'importados')!;
    expect(imp.body.replace(/\s/g, ' ')).toBe('Entraram 2 gastos (R$ 85,00) e 1 entrada (R$ 61,33). Toque para conferir as categorias.');
    const meta = list.find((n) => n.kind === 'meta')!;
    expect(meta.title).toBe('85% da meta de Alimentação');
    expect(Number.isInteger(meta.id) && meta.id > 0).toBe(true);

    expect((await poll(notify)).json().notifications).toEqual([]);

    // Só o que é novo entra no próximo aviso.
    await sync(syncKey, [item('d', 10_00)]);
    const next = (await poll(notify)).json().notifications;
    // Alimentação foi a 95%: continua na faixa de 80%, que já foi avisada.
    expect(next.map((n: { kind: string; body: string }) => [n.kind, n.body.replace(/\s/g, ' ')])).toEqual([
      ['importados', 'Entraram 1 gasto (R$ 10,00). Toque para conferir as categorias.']
    ]);
  });

  it('a chave de notificações só lê as notificações', async () => {
    const notify = await key('notify');
    const h = { authorization: `Bearer ${notify}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/transactions', headers: h })).statusCode).toBe(403);
    expect((await sync(notify, [item('x', 1_00)])).statusCode).toBe(403);
    // e a de sincronização não lê as notificações
    expect((await poll(await key('sync'))).statusCode).toBe(403);
  });

  it('pelo login normal também funciona', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/notifications', headers: user.headers });
    expect(r.statusCode).toBe(200);
  });
});
