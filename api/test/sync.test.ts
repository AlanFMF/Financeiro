import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { categorizeBank, cleanBankDescription } from '../src/lib/bank.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let user: Awaited<ReturnType<typeof ctx.register>>;
let token: string;
const bearer = () => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  ctx = await setup();
  user = await ctx.register('banco@x.com');
  const res = await ctx.app.inject({ method: 'POST', url: '/api/tokens', headers: user.headers, payload: { name: 'Tarefa do Claude' } });
  token = res.json().token;
});
afterEach(() => ctx.close());

const send = (items: object[], extra: object = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/sync/bank', headers: bearer(), payload: { source: 'Nubank cartão', items, ...extra } });
const list = async () => (await ctx.app.inject({ method: 'GET', url: '/api/transactions', headers: user.headers })).json().transactions;

const compra = (over: object = {}) => ({
  externalId: 'tx-1',
  date: '2026-10-11',
  amountCents: 23149,
  kind: 'saida',
  description: 'Levemax Superatacado P',
  bankCategory: 'Groceries',
  status: 'PENDING',
  ...over
});

describe('chaves de sincronização', () => {
  it('a chave aparece só na criação e só vale para /api/sync', async () => {
    expect(token).toMatch(/^saldo_[A-Za-z0-9_-]{32}$/);
    const listed = (await ctx.app.inject({ method: 'GET', url: '/api/tokens', headers: user.headers })).json().tokens;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed[0].hint).toBe(token.slice(-4));

    expect((await ctx.app.inject({ method: 'GET', url: '/api/sync/status', headers: bearer() })).statusCode).toBe(200);
    for (const [method, url] of [['GET', '/api/transactions'], ['GET', '/api/tokens'], ['GET', '/api/auth/me'], ['POST', '/api/tokens']] as const) {
      const res = await ctx.app.inject({ method, url, headers: bearer(), payload: method === 'POST' ? { name: 'x' } : undefined });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/sync/status', headers: { authorization: 'Bearer saldo_inventada' } })).statusCode).toBe(401);
  });

  it('chave revogada deixa de funcionar', async () => {
    const [t] = (await ctx.app.inject({ method: 'GET', url: '/api/tokens', headers: user.headers })).json().tokens;
    await ctx.app.inject({ method: 'DELETE', url: `/api/tokens/${t.id}`, headers: user.headers });
    expect((await send([compra()])).statusCode).toBe(401);
  });
});

describe('sincronização com o banco', () => {
  it('importa, categoriza pelo banco e não duplica ao reenviar', async () => {
    const first = (await send([compra()])).json();
    expect(first).toMatchObject({ created: 1, linked: 0, skipped: 0 });
    expect(first.items[0].category).toBe('Alimentação');

    const again = (await send([compra()])).json();
    expect(again).toMatchObject({ created: 0, skipped: 1 });

    const [tx] = await list();
    expect(tx).toMatchObject({ description: 'Levemax Superatacado P', amountCents: 23149, source: 'Nubank cartão', categoryName: 'Alimentação' });
  });

  it('compra pendente que volta confirmada com outro id é ligada à mesma', async () => {
    await send([compra()]);
    const posted = (await send([compra({ externalId: 'tx-1-posted', status: 'POSTED', date: '2026-10-12' })])).json();
    expect(posted).toMatchObject({ created: 0, linked: 1 });
    expect(await list()).toHaveLength(1);
  });

  it('duas compras iguais no mesmo dia continuam sendo duas', async () => {
    const r = (await send([compra({ status: 'POSTED' }), compra({ externalId: 'tx-2', status: 'POSTED' })])).json();
    expect(r.created).toBe(2);
  });

  it('liga ao lançamento feito à mão ou pelo chat em vez de duplicar', async () => {
    const manual = await ctx.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: user.headers,
      payload: { categoryId: user.cat('Alimentação'), date: '2026-10-10', amountCents: 23149, description: 'Mercado' }
    });
    const r = (await send([compra()])).json();
    expect(r).toMatchObject({ created: 0, linked: 1 });
    const txs = await list();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ id: manual.json().transaction.id, description: 'Mercado', source: 'Nubank cartão' });
  });

  it('ignora pagamento de fatura e o que é anterior à data inicial', async () => {
    const r = (
      await send(
        [
          { externalId: 'p1', date: '2026-10-08', amountCents: 113321, kind: 'entrada', description: 'Pagamento recebido', bankCategory: 'Credit card payment' },
          compra({ externalId: 'velha', date: '2026-10-01' }),
          compra()
        ],
        { notBefore: '2026-10-05' }
      )
    ).json();
    expect(r).toMatchObject({ created: 1, ignored: 2 });
  });

  it('não reimporta o que o usuário apagou', async () => {
    const r = (await send([compra()])).json();
    await ctx.app.inject({ method: 'DELETE', url: `/api/transactions/${r.items[0].transactionId}`, headers: user.headers });
    const again = (await send([compra()])).json();
    expect(again.items[0]).toMatchObject({ result: 'skipped', reason: 'apagado pelo usuário' });
    expect(await list()).toHaveLength(0);
  });

  it('usa o hábito do usuário antes da categoria do banco', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: user.headers,
      payload: { categoryId: user.cat('Extra'), date: '2026-09-01', amountCents: 5000, description: 'Pix de Fulano Silva' }
    });
    const r = (
      await send([{ externalId: 'pix', date: '2026-10-13', amountCents: 7344, kind: 'entrada', description: 'Transferência Recebida|FULANO SILVA', bankCategory: 'Transfers' }], {
        source: 'Nubank conta'
      })
    ).json();
    expect(r.items[0].category).toBe('Extra');
    expect((await list())[0].description).toBe('Pix de Fulano Silva');
  });

  it('devolve o resumo do dia e as metas que passaram de 80%', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    await ctx.app.inject({ method: 'PUT', url: `/api/budgets/${user.cat('Alimentação')}`, headers: user.headers, payload: { budgetCents: 250_00 } });
    const body = (
      await send([
        compra({ date: today }),
        compra({ externalId: 'tx-2', date: today, amountCents: 50_00, kind: 'entrada', description: 'Transferência Recebida|Fulano', bankCategory: 'Transfers' })
      ])
    ).json();
    expect(body.summary).toEqual({ saida: { count: 1, cents: 23149 }, entrada: { count: 1, cents: 5000 } });
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({ level: 80, pct: 92 });
    expect(body.alerts[0].message).toContain('92% da meta de Alimentação');
    // O app ainda recebe o próprio aviso quando for aberto.
    const month = today.slice(0, 7);
    const pending = (await ctx.app.inject({ method: 'POST', url: '/api/budgets/alerts', headers: user.headers, payload: { month } })).json();
    expect(pending.alerts).toHaveLength(1);
  });

  it('valida o formato e limita o lote', async () => {
    expect((await send([{ externalId: 'x', date: '13/10/2026', amountCents: 10, kind: 'saida' }])).statusCode).toBe(400);
    expect((await send(Array.from({ length: 501 }, (_, i) => compra({ externalId: `t${i}` })))).statusCode).toBe(400);
  });
});

describe('descrições e categorias do extrato', () => {
  it.each([
    ['Transferência Recebida|Leonardo Borges Barcelos', undefined, 'Pix de Leonardo Borges Barcelos'],
    ['Transferência enviada pelo Pix|CEMIG DISTRIBUICAO S.A', undefined, 'Pix para Cemig Distribuicao S.A'],
    ['Pagamento efetuado|IVAN NEGOCIOS IMOBILIARIOS LTD', undefined, 'Pagamento a Ivan Negocios Imobiliarios Ltd'],
    ['Compra no débito|ANGELO APARECIDO BARBO', undefined, 'Angelo Aparecido Barbo'],
    ['Shopee *Jimmystore 5/6', undefined, 'Shopee *Jimmystore (5/6)'],
    ['SHOPEE *SHPSTECNOLOGIA 7/9', { number: 7, total: 9 }, 'Shopee *shpstecnologia (7/9)'],
    ['Transferência Recebida', undefined, 'Transferência Recebida']
  ])('"%s"', (raw, inst, expected) => {
    expect(cleanBankDescription(raw, inst)).toBe(expected);
  });

  it.each([
    ['Pix para Cemig Distribuicao S.A', 'saida', 'Electricity', 'Moradia'],
    ['Google Claude By Anth', 'saida', 'Digital services', 'Assinaturas'],
    ['Amazon Ad Free For Pri', 'saida', 'Digital services', 'Assinaturas'],
    ['Uberlandia (2/3)', 'saida', 'Shopping', 'Compras'],
    ['Uberlandia', 'saida', 'Taxi and ride-hailing', 'Transporte'],
    ['Pg *Hinova Itucar Prot', 'saida', 'Shopping', 'Transporte'],
    ['Pix de Fulano', 'entrada', 'Transfers', 'Outras receitas'],
    ['Pagamento a Ivan Negocios Imobiliarios Ltd', 'saida', 'Entrepreneurial activities', 'Imprevistos/Outros']
  ] as const)('"%s" (%s, %s) → %s', (desc, kind, bank, expected) => {
    expect(categorizeBank(desc, kind, bank, [])).toBe(expected);
  });
});
