import { describe, expect, it } from 'vitest';
import { findDate, normalizeAmounts, parseByRules } from '../src/assistant/rules.js';
import { TODAY, lastResult, say, scriptedProvider, setupAi, tool } from './ai-helpers.js';

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

describe('IA: correções, exclusões e contexto', () => {
  it('corrige o valor de um lançamento recente e devolve o cartão alterado', async () => {
    let gasolinaId = 0;
    const fake = scriptedProvider([
      (rec) => {
        gasolinaId = Number(rec.system.match(/#(\d+) \| 2026-10-15 \| saida \| Transporte \| Gasolina/)![1]);
        return tool('corrigir_lancamento', { id: gasolinaId, valor: 160 });
      },
      (rec) => say(lastResult(rec).startsWith('Corrigido') ? 'Corrigi a gasolina para R$ 160,00.' : 'falhou')
    ]);
    const ctx = await setupAi(fake.factory);
    await ctx.importCsv('Data,Categoria,Descrição,Entrada,Saída\n15/10/2026,Transporte,Gasolina,,120');

    const body = (await ctx.chat('na verdade a gasolina foi 160')).json();
    expect(body.reply).toBe('Corrigi a gasolina para R$ 160,00.');
    expect(body.transactions).toEqual([]);
    expect(body.updated).toMatchObject([{ id: gasolinaId, amountCents: 16000, categoryName: 'Transporte' }]);
    expect((await ctx.list())[0].amountCents).toBe(16000);
    await ctx.close();
  });

  it('exclui quando pedido e não toca em lançamento de outra pessoa', async () => {
    let target = 0;
    const fake = scriptedProvider([() => tool('excluir_lancamento', { id: target }), (rec) => say(lastResult(rec))]);
    const ctx = await setupAi(fake.factory);
    await ctx.importCsv('Data,Categoria,Descrição,Entrada,Saída\n14/10/2026,Transporte,Uber,,32');
    const [uber] = await ctx.list();
    target = uber.id;

    // Outro usuário, com a própria IA conectada, tenta apagar o lançamento do dono.
    const intruder = await ctx.register('outro@x.com');
    await ctx.app.inject({ method: 'PUT', url: '/api/assistant/settings', headers: intruder, payload: { provider: 'openai', apiKey: 'sk-proj-intruso-9999' } });
    const attempt = (await ctx.chat(`apaga o lançamento ${uber.id}`, intruder)).json();
    expect(attempt.reply).toContain('não encontrado');
    expect(await ctx.list()).toHaveLength(1);

    // O dono pede e a exclusão acontece.
    const ok = (await ctx.chat('apaga o do uber')).json();
    expect(ok.deleted).toMatchObject([{ id: uber.id, description: 'Uber' }]);
    expect(await ctx.list()).toHaveLength(0);
    await ctx.close();
  });

  it('manda à IA os hábitos de categoria e os lançamentos recentes', async () => {
    const fake = scriptedProvider([() => say('ok')]);
    const ctx = await setupAi(fake.factory);
    await ctx.importCsv(
      'Data,Categoria,Descrição,Entrada,Saída\n01/10/2026,Pet,Ração,,90\n08/10/2026,Pet,Ração,,90\n09/10/2026,Lazer,Padaria do Zé,,20'
    );
    await ctx.chat('oi');
    const sys = fake.sessions[0].system;
    expect(sys).toMatch(/"Ração" → Pet\n- "Padaria do Zé" → Lazer/);
    expect(sys).toMatch(/#\d+ \| 2026-10-09 \| saida \| Lazer \| Padaria do Zé \| R\$\s20,00/);
    await ctx.close();
  });
});

describe('modo simples na API', () => {
  it('usa o histórico e apaga o último lançamento quando pedido', async () => {
    const ctx = await setupAi();
    await ctx.importCsv('Data,Categoria,Descrição,Entrada,Saída\n01/10/2026,Lazer,Padaria do Zé,,20');

    const added = (await ctx.chat('padaria do zé 35 ontem')).json();
    expect(added.transactions).toMatchObject([{ categoryName: 'Lazer', amountCents: 3500, date: '2026-10-15' }]);

    const removed = (await ctx.chat('apaga o último')).json();
    expect(removed.deleted).toMatchObject([{ id: added.transactions[0].id }]);
    expect(await ctx.list()).toHaveLength(1);
    await ctx.close();
  });
});
