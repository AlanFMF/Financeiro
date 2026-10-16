import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { parseByRules } from '../src/assistant/rules.js';
import type { Llm } from '../src/assistant/route.js';

/** Modelo falso: devolve as respostas roteirizadas e guarda o que recebeu. */
function scriptedLlm(script: ((p: Anthropic.MessageCreateParamsNonStreaming) => Partial<Anthropic.Message>)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const llm: Llm = async (params) => {
    calls.push(structuredClone(params));
    const step = script[calls.length - 1];
    if (!step) throw new Error('modelo falso sem roteiro');
    return { id: 'msg', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [], ...step(params) } as Anthropic.Message;
  };
  return { llm, calls };
}

const toolUse = (name: string, input: unknown, id = 'tu_1'): Partial<Anthropic.Message> => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock]
});
const text = (t: string): Partial<Anthropic.Message> => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t } as Anthropic.TextBlock] });

async function setup(llm: Llm | null, extra: Record<string, number> = {}) {
  const db: Db = await createPgliteDb();
  await migrate(db);
  const app = await buildApp({ db, jwtSecret: 't', rateLimit: false, assistant: { llm, ...extra } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Alan', email: 'a@a.com', password: '12345678' } });
  const headers = { authorization: `Bearer ${reg.json().token}` };
  const chat = (content: string, today = '2026-10-16') =>
    app.inject({ method: 'POST', url: '/api/assistant/chat', headers, payload: { messages: [{ role: 'user', content }], today } });
  return { app, db, headers, chat, close: async () => (await app.close(), await db.close()) };
}

describe('assistente com IA', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let fake: ReturnType<typeof scriptedLlm>;

  beforeAll(async () => {
    fake = scriptedLlm([
      () =>
        toolUse('registrar_lancamentos', {
          itens: [
            { tipo: 'saida', categoria: 'Alimentação', valor: 45.9, data: '2026-10-16', descricao: 'Mercado' },
            { tipo: 'saida', categoria: 'transporte', valor: 120, data: '2026-10-15', descricao: 'Gasolina' },
            { tipo: 'saida', categoria: 'Categoria que não existe', valor: 30, data: 'ontem', descricao: 'Coisa' },
            { tipo: 'saida', categoria: 'Lazer', valor: -5, data: '2026-10-16', descricao: 'Inválido' }
          ]
        }),
      (p) => {
        const last = p.messages.at(-1)!;
        const result = (last.content as Anthropic.ToolResultBlockParam[])[0].content as string;
        return text(result.includes('ERRO') ? 'Lancei 3 itens; faltou o valor de um.' : 'Lancei tudo.');
      }
    ]);
    ctx = await setup(fake.llm);
  });
  afterAll(() => ctx.close());

  it('grava os lançamentos que o modelo extraiu e devolve o texto final', async () => {
    const res = await ctx.chat('gastei 45,90 no mercado e 120 de gasolina ontem');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBe('Lancei 3 itens; faltou o valor de um.');
    expect(body.mode).toBe('ia');
    expect(body.transactions.map((t: { categoryName: string; amountCents: number; date: string }) => [t.categoryName, t.amountCents, t.date])).toEqual([
      ['Alimentação', 4590, '2026-10-16'],
      ['Transporte', 12000, '2026-10-15'],
      ['Imprevistos/Outros', 3000, '2026-10-16']
    ]);
  });

  it('manda ao modelo a data de hoje, as categorias do usuário e as ferramentas', () => {
    const first = fake.calls[0];
    expect(first.model).toBe('claude-haiku-5-5');
    expect(first.system).toContain('2026-10-16');
    expect(first.system).toContain('- Moradia (aluguel, condomínio, energia/luz');
    expect(first.tools?.map((t) => (t as Anthropic.Tool).name)).toEqual(['registrar_lancamentos', 'consultar_lancamentos', 'resumo_do_mes']);
  });

  it('os lançamentos aparecem na lista normal do app', async () => {
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/transactions?month=2026-10', headers: ctx.headers })).json();
    expect(list.transactions).toHaveLength(3);
  });

  it('rejeita conversa que termina com mensagem do assistente', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      headers: ctx.headers,
      payload: { messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }] }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('assistente: consultas e falhas', () => {
  it('responde perguntas usando a ferramenta de resumo', async () => {
    const fake = scriptedLlm([
      () => toolUse('resumo_do_mes', { mes: '2026-10' }),
      (p) => {
        const r = ((p.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0].content as string).split('\n')[0];
        return text(r);
      }
    ]);
    const ctx = await setup(fake.llm);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/import/csv',
      headers: ctx.headers,
      payload: { csv: 'Data,Categoria,Descrição,Entrada,Saída\n05/10/2026,Pró-labore/Salário,Salário,4200,\n06/10/2026,Moradia,Luz,,300', dryRun: false }
    });
    const body = (await ctx.chat('quanto sobrou esse mês?')).json();
    expect(body.reply).toMatch(/entradas R\$\s4\.200,00, saídas R\$\s300,00, saldo R\$\s3\.900,00/);
    expect(body.transactions).toEqual([]);
    await ctx.close();
  });

  it('erro da API vira mensagem clara sem derrubar o servidor', async () => {
    const llm: Llm = async () => {
      throw new Error('rede caiu');
    };
    const ctx = await setup(llm);
    const res = await ctx.chat('gastei 10 no café');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('A IA não respondeu');
    await ctx.close();
  });

  it('limita mensagens das contas de demonstração', async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const app = await buildApp({ db, jwtSecret: 't', rateLimit: false, assistant: { llm: null, demoLimit: 2 } });
    const { token } = (await app.inject({ method: 'POST', url: '/api/auth/demo' })).json();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/assistant/chat',
        headers: { authorization: `Bearer ${token}` },
        payload: { messages: [{ role: 'user', content: 'gastei 5 no café' }] }
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const third = await send();
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toContain('Crie uma conta');
    await app.close();
    await db.close();
  });
});

describe('modo simples (sem chave da IA)', () => {
  it('lança pelo endpoint usando as regras', async () => {
    const ctx = await setup(null);
    const status = (await ctx.app.inject({ method: 'GET', url: '/api/assistant/status', headers: ctx.headers })).json();
    expect(status.mode).toBe('simples');
    const body = (await ctx.chat('paguei 150 de condomínio e 89,90 de internet')).json();
    expect(body.reply.replace(/\s/g, ' ')).toBe('Lancei R$ 150,00 em Moradia e R$ 89,90 em Contas.');
    await ctx.close();
  });

  it.each([
    ['gastei 45,90 no mercado', [['saida', 'Alimentação', 4590, '2026-10-16', 'Mercado']]],
    ['recebi 4.200 de salário', [['entrada', 'Pró-labore/Salário', 420000, '2026-10-16', 'Salário']]],
    ['ontem paguei R$ 1.227,76 do financiamento do carro', [['saida', 'Transporte', 122776, '2026-10-15', 'Financiamento do carro']]],
    ['gastei 30 no uber; 25 na farmácia', [['saida', 'Transporte', 3000, '2026-10-16', 'Uber'], ['saida', 'Saúde', 2500, '2026-10-16', 'Farmácia']]],
    ['dia 10 paguei 300 de luz', [['saida', 'Moradia', 30000, '2026-10-10', 'Luz']]],
    ['oi, tudo bem?', []]
  ])('"%s"', (msg, expected) => {
    expect(parseByRules(msg, '2026-10-16').map((i) => [i.kind, i.category, i.amountCents, i.date, i.description])).toEqual(expected);
  });
});
