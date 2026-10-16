import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createPgliteDb, migrate } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { findDate, normalizeAmounts, parseByRules } from '../src/assistant/rules.js';
import type { Llm } from '../src/assistant/route.js';

const TODAY = '2026-10-16'; // sexta-feira

describe('modo simples: frases mais complexas', () => {
  const run = (msg: string, history = []) =>
    parseByRules(msg, TODAY, history).map((i) => [i.kind, i.category, i.amountCents, i.date, i.description, i.isFixed]);

  it.each([
    ['paguei cinquenta reais e noventa centavos de luz na sexta passada', [['saida', 'Moradia', 5090, '2026-10-09', 'Luz', false]]],
    ['comprei um tênis de 600 em 6x no cartão', [['saida', 'Compras', 10000, TODAY, 'Tênis (1/6)', true]]],
    ['comprei uma tv em 10x de 89,90', [['saida', 'Compras', 8990, TODAY, 'Tv (1/10)', true]]],
    ['parcela 3/10 do notebook 350', [['saida', 'Compras', 35000, TODAY, 'Notebook (3/10)', true]]],
    ['caiu o salário, 4.850', [['entrada', 'Pró-labore/Salário', 485000, TODAY, 'Salário', false]]],
    ['uber 32', [['saida', 'Transporte', 3200, TODAY, 'Uber', false]]],
    ['dia 10 paguei 1,2 mil de aluguel', [['saida', 'Moradia', 120000, '2026-10-10', 'Aluguel', false]]],
    ['dia 20 paguei 300 de luz', [['saida', 'Moradia', 30000, '2026-09-20', 'Luz', false]]],
    ['gastei vinte e cinco no uber', [['saida', 'Transporte', 2500, TODAY, 'Uber', false]]],
    ['recebi mil e duzentos de reembolso', [['entrada', 'Outras receitas', 120000, TODAY, 'Reembolso', false]]],
    ['comprei 2 cafés de 10', [['saida', 'Alimentação', 1000, TODAY, '2 cafés', false]]],
    ['paguei 15 no 99', [['saida', 'Transporte', 1500, TODAY, '99', false]]],
    ['netflix 44,90 todo mês', [['saida', 'Assinaturas', 4490, TODAY, 'Netflix', true]]],
    ['na terça gastei 18 no pão', [['saida', 'Alimentação', 1800, '2026-10-13', 'Pão', false]]],
    ['gastei 30 reais no mercado dia 12/09', [['saida', 'Alimentação', 3000, '2026-09-12', 'Mercado', false]]],
    ['pix de 1.500 do cliente', [['entrada', 'Extra', 150000, TODAY, 'Pix do cliente', false]]],
    [
      'ontem gastei 30 no uber e 25 na farmácia',
      [
        ['saida', 'Transporte', 3000, '2026-10-15', 'Uber', false],
        ['saida', 'Saúde', 2500, '2026-10-15', 'Farmácia', false]
      ]
    ],
    [
      'abasteci 150 e passei no drive-thru, 38',
      [
        ['saida', 'Transporte', 15000, TODAY, 'Combustível', false],
        ['saida', 'Alimentação', 3800, TODAY, 'Drive-thru', false]
      ]
    ],
    [
      'mercado 230 no pix, farmácia 42,50 no débito e 2k de aluguel',
      [
        ['saida', 'Alimentação', 23000, TODAY, 'Mercado', false],
        ['saida', 'Saúde', 4250, TODAY, 'Farmácia', false],
        ['saida', 'Moradia', 200000, TODAY, 'Aluguel', false]
      ]
    ],
    [
      'recebi 600 de freela e paguei 89,90 de internet',
      [
        ['entrada', 'Extra', 60000, TODAY, 'Freela', false],
        ['saida', 'Contas', 8990, TODAY, 'Internet', false]
      ]
    ]
  ])('"%s"', (msg, expected) => {
    expect(run(msg)).toEqual(expected);
  });

  it('aprende a categoria com o histórico do usuário', () => {
    const history = [
      { description: 'Ração', category: 'Pet', kind: 'saida' as const },
      { description: 'Thor', category: 'Pet', kind: 'saida' as const },
      { description: 'Padaria do Zé', category: 'Lazer', kind: 'saida' as const }
    ];
    expect(parseByRules('ração do thor 89', TODAY, history)[0]).toMatchObject({ category: 'Pet', description: 'Ração do thor' });
    // O hábito vence a palavra-chave: este usuário lança a padaria do Zé em Lazer.
    expect(parseByRules('padaria do zé 22', TODAY, history)[0].category).toBe('Lazer');
  });

  it('não confunde quantidade escrita por extenso com valor', () => {
    expect(normalizeAmounts('comprei duas pizzas')).toBe('comprei duas pizzas');
    expect(normalizeAmounts('uma pizza de 40')).toBe('uma pizza de 40');
    expect(normalizeAmounts('paguei cento e cinquenta reais')).toBe('paguei 150 reais');
    expect(normalizeAmounts('dois mil e quinhentos de aluguel')).toBe('2500 de aluguel');
  });

  it('nunca cai no futuro com datas sem ano', () => {
    expect(findDate('25/12', TODAY)).toBe('2025-12-25');
    expect(findDate('segunda retrasada', TODAY)).toBe('2026-10-05');
    expect(findDate('sexta', TODAY)).toBe(TODAY);
    expect(findDate('sexta passada', TODAY)).toBe('2026-10-09');
  });
});

/** Modelo falso que segue um roteiro e guarda as chamadas. */
function scripted(steps: ((p: Anthropic.MessageCreateParamsNonStreaming) => Partial<Anthropic.Message>)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const llm: Llm = async (params) => {
    calls.push(structuredClone(params));
    const step = steps[calls.length - 1];
    return { id: 'm', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [], ...step(params) } as Anthropic.Message;
  };
  return { llm, calls };
}
const tool = (name: string, input: unknown): Partial<Anthropic.Message> => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input } as Anthropic.ToolUseBlock]
});
const say = (text: string): Partial<Anthropic.Message> => ({ content: [{ type: 'text', text } as Anthropic.TextBlock] });
const lastToolResult = (p: Anthropic.MessageCreateParamsNonStreaming) =>
  ((p.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0].content as string);

async function setup(llm: Llm | null) {
  const db = await createPgliteDb();
  await migrate(db);
  const app = await buildApp({ db, jwtSecret: 't', rateLimit: false, assistant: { llm } });
  const register = async (email: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'X', email, password: '12345678' } });
    return { authorization: `Bearer ${r.json().token}` };
  };
  const headers = await register('dono@x.com');
  const chat = (content: string, h = headers) =>
    app.inject({ method: 'POST', url: '/api/assistant/chat', headers: h, payload: { messages: [{ role: 'user', content }], today: TODAY } });
  const importCsv = (csv: string) => app.inject({ method: 'POST', url: '/api/import/csv', headers, payload: { csv, dryRun: false } });
  const list = async () => (await app.inject({ method: 'GET', url: '/api/transactions', headers })).json().transactions;
  return { app, db, headers, register, chat, importCsv, list, close: async () => (await app.close(), await db.close()) };
}

describe('IA: correções, exclusões e contexto', () => {
  it('corrige o valor de um lançamento recente e devolve o cartão alterado', async () => {
    let gasolinaId = 0;
    const fake = scripted([
      (p) => {
        const sys = p.system as string;
        gasolinaId = Number(sys.match(/#(\d+) \| 2026-10-15 \| saida \| Transporte \| Gasolina/)![1]);
        return tool('corrigir_lancamento', { id: gasolinaId, valor: 160 });
      },
      (p) => say(lastToolResult(p).startsWith('Corrigido') ? 'Corrigi a gasolina para R$ 160,00.' : 'falhou')
    ]);
    const ctx = await setup(fake.llm);
    await ctx.importCsv('Data,Categoria,Descrição,Entrada,Saída\n15/10/2026,Transporte,Gasolina,,120');

    const body = (await ctx.chat('na verdade a gasolina foi 160')).json();
    expect(body.reply).toBe('Corrigi a gasolina para R$ 160,00.');
    expect(body.transactions).toEqual([]);
    expect(body.updated).toMatchObject([{ id: gasolinaId, amountCents: 16000, categoryName: 'Transporte' }]);
    expect((await ctx.list())[0].amountCents).toBe(16000);
    await ctx.close();
  });

  it('exclui quando pedido e não toca em lançamento de outra pessoa', async () => {
    const ctx = await setup(null);
    const intruder = await ctx.register('outro@x.com');
    await ctx.importCsv('Data,Categoria,Descrição,Entrada,Saída\n14/10/2026,Transporte,Uber,,32');
    const [uber] = await ctx.list();

    // O outro usuário tenta, via IA, apagar o lançamento do dono.
    const fake = scripted([() => tool('excluir_lancamento', { id: uber.id }), (p) => say(lastToolResult(p))]);
    const app2 = await buildApp({ db: ctx.db, jwtSecret: 't', rateLimit: false, assistant: { llm: fake.llm } });
    const attempt = (
      await app2.inject({
        method: 'POST',
        url: '/api/assistant/chat',
        headers: intruder,
        payload: { messages: [{ role: 'user', content: `apaga o lançamento ${uber.id}` }], today: TODAY }
      })
    ).json();
    expect(attempt.reply).toContain('não encontrado');
    expect(await ctx.list()).toHaveLength(1);

    // O dono pede e a exclusão acontece.
    const fake2 = scripted([() => tool('excluir_lancamento', { id: uber.id }), () => say('Apaguei o Uber de R$ 32,00.')]);
    const app3 = await buildApp({ db: ctx.db, jwtSecret: 't', rateLimit: false, assistant: { llm: fake2.llm } });
    const ok = (
      await app3.inject({
        method: 'POST',
        url: '/api/assistant/chat',
        headers: ctx.headers,
        payload: { messages: [{ role: 'user', content: 'apaga o do uber' }], today: TODAY }
      })
    ).json();
    expect(ok.deleted).toMatchObject([{ id: uber.id, description: 'Uber' }]);
    expect(await ctx.list()).toHaveLength(0);
    await app2.close();
    await app3.close();
    await ctx.close();
  });

  it('manda ao modelo os hábitos de categoria e os lançamentos recentes', async () => {
    const fake = scripted([() => say('ok')]);
    const ctx = await setup(fake.llm);
    await ctx.importCsv(
      'Data,Categoria,Descrição,Entrada,Saída\n01/10/2026,Pet,Ração,,90\n08/10/2026,Pet,Ração,,90\n09/10/2026,Lazer,Padaria do Zé,,20'
    );
    await ctx.chat('oi');
    const sys = fake.calls[0].system as string;
    expect(sys).toMatch(/"Ração" → Pet\n- "Padaria do Zé" → Lazer/);
    expect(sys).toMatch(/#\d+ \| 2026-10-09 \| saida \| Lazer \| Padaria do Zé \| R\$\s20,00/);
    await ctx.close();
  });
});

describe('modo simples na API', () => {
  it('usa o histórico e apaga o último lançamento quando pedido', async () => {
    const ctx = await setup(null);
    await ctx.importCsv('Data,Categoria,Descrição,Entrada,Saída\n01/10/2026,Lazer,Padaria do Zé,,20');

    const added = (await ctx.chat('padaria do zé 35 ontem')).json();
    expect(added.transactions).toMatchObject([{ categoryName: 'Lazer', amountCents: 3500, date: '2026-10-15' }]);

    const removed = (await ctx.chat('apaga o último')).json();
    expect(removed.deleted).toMatchObject([{ id: added.transactions[0].id }]);
    expect(await ctx.list()).toHaveLength(1);
    await ctx.close();
  });
});
