import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/assistant/providers.js';
import { parseByRules } from '../src/assistant/rules.js';
import { createSecretBox } from '../src/lib/secret.js';
import { TODAY, lastResult, say, scriptedProvider, setupAi, tool } from './ai-helpers.js';

describe('conectar a própria IA', () => {
  it('testa a chave, guarda criptografada e nunca devolve a chave', async () => {
    const tested: string[] = [];
    const ctx = await setupAi(undefined, async (provider, key) => {
      tested.push(`${provider}:${key}`);
      if (key.includes('errada')) throw new ProviderError('auth', 'A chave do Claude foi recusada.');
    });
    const put = (payload: object) => ctx.app.inject({ method: 'PUT', url: '/api/assistant/settings', headers: ctx.headers, payload });

    const bad = await put({ provider: 'claude', apiKey: 'sk-ant-chave-errada-0000' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('recusada');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/assistant/status', headers: ctx.headers })).json().mode).toBe('simples');

    const ok = await put({ provider: 'claude', apiKey: 'sk-ant-api03-certa-WXYZ' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ configured: true, provider: 'claude', model: 'claude-haiku-5-5', keyHint: 'WXYZ' });
    expect(ok.body).not.toContain('sk-ant-api03-certa');
    expect(tested).toEqual(['claude:sk-ant-chave-errada-0000', 'claude:sk-ant-api03-certa-WXYZ']);

    const stored = (await ctx.db.query<{ key_encrypted: string }>('select key_encrypted from ai_settings')).rows[0].key_encrypted;
    expect(stored).not.toContain('certa');
    expect(createSecretBox('test').decrypt(stored)).toBe('sk-ant-api03-certa-WXYZ');

    // Trocar só o modelo não pede a chave de novo.
    const model = await put({ provider: 'claude', model: 'claude-sonnet-5-5' });
    expect(model.json()).toMatchObject({ model: 'claude-sonnet-5-5', keyHint: 'WXYZ' });
    // Trocar de IA exige a chave da nova.
    expect((await put({ provider: 'openai' })).statusCode).toBe(400);

    const status = await ctx.app.inject({ method: 'GET', url: '/api/assistant/status', headers: ctx.headers });
    expect(status.json()).toEqual({ mode: 'ia', provider: 'claude', model: 'claude-sonnet-5-5' });

    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/assistant/settings', headers: ctx.headers })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/assistant/settings', headers: ctx.headers })).json().configured).toBe(false);
    await ctx.close();
  });

  it('a chave de um usuário não serve para outro', async () => {
    const fake = scriptedProvider([() => say('oi')]);
    const ctx = await setupAi(fake.factory);
    const other = await ctx.register('outro@x.com');
    const body = (await ctx.chat('gastei 10 no café', other)).json();
    expect(body.mode).toBe('simples');
    expect(fake.sessions).toHaveLength(0);
    await ctx.close();
  });

  it('a criptografia rejeita dado adulterado', () => {
    const box = createSecretBox('segredo');
    const packed = box.encrypt('minha-chave');
    const tampered = packed.slice(0, -4) + (packed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => createSecretBox('outro-segredo').decrypt(packed)).toThrow();
  });
});

describe('assistente com IA', () => {
  it('grava os lançamentos que a IA extraiu e devolve a resposta final', async () => {
    const fake = scriptedProvider([
      () =>
        tool('registrar_lancamentos', {
          itens: [
            { tipo: 'saida', categoria: 'Alimentação', valor: 45.9, data: TODAY, descricao: 'Mercado' },
            { tipo: 'saida', categoria: 'transporte', valor: 120, data: '2026-10-15', descricao: 'Gasolina' },
            { tipo: 'saida', categoria: 'Categoria que não existe', valor: 30, data: 'ontem', descricao: 'Coisa' },
            { tipo: 'saida', categoria: 'Lazer', valor: -5, data: TODAY, descricao: 'Inválido' }
          ]
        }),
      (rec) => say(lastResult(rec).includes('ERRO') ? 'Lancei 3 itens; faltou o valor de um.' : 'Lancei tudo.')
    ]);
    const ctx = await setupAi(fake.factory);
    const res = await ctx.chat('gastei 45,90 no mercado e 120 de gasolina ontem');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBe('Lancei 3 itens; faltou o valor de um.');
    expect(body.mode).toBe('ia');
    expect(body.transactions.map((t: { categoryName: string; amountCents: number; date: string }) => [t.categoryName, t.amountCents, t.date])).toEqual([
      ['Alimentação', 4590, TODAY],
      ['Transporte', 12000, '2026-10-15'],
      ['Imprevistos/Outros', 3000, TODAY]
    ]);
    expect(await ctx.list()).toHaveLength(3);

    const rec = fake.sessions[0];
    expect(rec.config).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'AIza-chave-de-teste-1234' });
    expect(rec.system).toContain('2026-10-16 (sexta, hoje)');
    expect(rec.system).toContain('- Moradia (aluguel, condomínio, energia/luz');
    expect(rec.tools.map((t) => t.name)).toEqual([
      'registrar_lancamentos',
      'corrigir_lancamento',
      'excluir_lancamento',
      'consultar_lancamentos',
      'consultar_metas',
      'definir_meta',
      'resumo_do_mes'
    ]);
    await ctx.close();
  });

  it('responde perguntas usando a ferramenta de resumo', async () => {
    const fake = scriptedProvider([() => tool('resumo_do_mes', { mes: '2026-10' }), (rec) => say(lastResult(rec).split('\n')[0])]);
    const ctx = await setupAi(fake.factory);
    await ctx.importCsv('Data,Categoria,Descrição,Entrada,Saída\n05/10/2026,Pró-labore/Salário,Salário,4200,\n06/10/2026,Moradia,Luz,,300');
    const body = (await ctx.chat('quanto sobrou esse mês?')).json();
    expect(body.reply).toMatch(/entradas R\$\s4\.200,00, saídas R\$\s300,00, saldo R\$\s3\.900,00/);
    expect(body.transactions).toEqual([]);
    await ctx.close();
  });

  it('erro da IA vira mensagem clara', async () => {
    const fake = scriptedProvider([
      () => {
        throw new ProviderError('quota', 'Sua conta do Gemini atingiu o limite de uso ou está sem créditos.');
      }
    ]);
    const ctx = await setupAi(fake.factory);
    const res = await ctx.chat('gastei 10 no café');
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain('limite de uso');
    await ctx.close();
  });

  it('mantém o que já foi gravado se a IA cair no meio', async () => {
    const fake = scriptedProvider([
      () => tool('registrar_lancamentos', { itens: [{ tipo: 'saida', categoria: 'Lazer', valor: 30, data: TODAY, descricao: 'Cinema' }] }),
      () => {
        throw new Error('rede caiu');
      }
    ]);
    const ctx = await setupAi(fake.factory);
    const body = (await ctx.chat('cinema 30')).json();
    expect(body.reply).toContain('parou de responder');
    expect(body.transactions).toHaveLength(1);
    await ctx.close();
  });

  it('rejeita conversa que termina com mensagem do assistente', async () => {
    const ctx = await setupAi();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      headers: ctx.headers,
      payload: { messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }] }
    });
    expect(res.statusCode).toBe(400);
    await ctx.close();
  });
});

describe('modo simples (sem IA conectada)', () => {
  it('lança pelo endpoint usando as regras', async () => {
    const ctx = await setupAi();
    const body = (await ctx.chat('paguei 150 de condomínio e 89,90 de internet')).json();
    expect(body.mode).toBe('simples');
    expect(body.reply.replace(/\s/g, ' ')).toBe('Lancei R$ 150,00 em Moradia e R$ 89,90 em Contas.');
    await ctx.close();
  });

  it.each([
    ['gastei 45,90 no mercado', [['saida', 'Alimentação', 4590, TODAY, 'Mercado']]],
    ['recebi 4.200 de salário', [['entrada', 'Pró-labore/Salário', 420000, TODAY, 'Salário']]],
    ['ontem paguei R$ 1.227,76 do financiamento do carro', [['saida', 'Transporte', 122776, '2026-10-15', 'Financiamento do carro']]],
    ['gastei 30 no uber; 25 na farmácia', [['saida', 'Transporte', 3000, TODAY, 'Uber'], ['saida', 'Saúde', 2500, TODAY, 'Farmácia']]],
    ['dia 10 paguei 300 de luz', [['saida', 'Moradia', 30000, '2026-10-10', 'Luz']]],
    ['oi, tudo bem?', []]
  ])('"%s"', (msg, expected) => {
    expect(parseByRules(msg, TODAY).map((i) => [i.kind, i.category, i.amountCents, i.date, i.description])).toEqual(expected);
  });
});
