import { describe, expect, it } from 'vitest';
import { createProviderSession, verifyApiKey, ProviderError, type ToolDef } from '../src/assistant/providers.js';

/** fetch falso: devolve as respostas em ordem e guarda as requisições. */
function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = responses[requests.length - 1];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, requests };
}

const tools: ToolDef[] = [
  { name: 'registrar_lancamentos', description: 'Grava', parameters: { type: 'object', properties: { itens: { type: 'array' } }, required: ['itens'] } }
];
const history = [{ role: 'user' as const, content: 'gastei 10 no café' }];
const ITENS = { itens: [{ tipo: 'saida', valor: 10 }] };

describe('Claude (Messages API)', () => {
  it('envia sistema, ferramentas e histórico; devolve o resultado da ferramenta', async () => {
    const f = fakeFetch([
      { body: { content: [{ type: 'text', text: 'Vou lançar.' }, { type: 'tool_use', id: 'toolu_1', name: 'registrar_lancamentos', input: ITENS }] } },
      { body: { content: [{ type: 'text', text: 'Lancei R$ 10,00.' }] } }
    ]);
    const s = createProviderSession({ provider: 'claude', apiKey: 'sk-ant-x', model: 'claude-haiku-5-5', fetch: f.fn });

    const t1 = await s.start({ system: 'SYS', history, tools });
    expect(t1.toolCalls).toEqual([{ id: 'toolu_1', name: 'registrar_lancamentos', input: ITENS }]);
    const t2 = await s.continue([{ call: t1.toolCalls[0], content: 'OK #1' }]);
    expect(t2).toEqual({ text: 'Lancei R$ 10,00.', toolCalls: [] });

    const [r1, r2] = f.requests;
    expect(r1.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r1.headers).toMatchObject({ 'x-api-key': 'sk-ant-x', 'anthropic-version': '2023-06-01' });
    expect(r1.body).toMatchObject({ model: 'claude-haiku-5-5', system: 'SYS', messages: history });
    expect(r1.body.tools[0]).toEqual({ name: 'registrar_lancamentos', description: 'Grava', input_schema: tools[0].parameters });
    expect(r2.body.messages.at(-2).role).toBe('assistant');
    expect(r2.body.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'OK #1' }] });
  });
});

describe('ChatGPT (Responses API)', () => {
  it('usa instructions, ferramentas no formato plano e encadeia por previous_response_id', async () => {
    const f = fakeFetch([
      {
        body: {
          id: 'resp_1',
          output: [
            { type: 'reasoning', id: 'rs_1', summary: [] },
            { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'registrar_lancamentos', arguments: JSON.stringify(ITENS) }
          ]
        }
      },
      { body: { id: 'resp_2', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Lancei R$ 10,00.' }] }] } }
    ]);
    const s = createProviderSession({ provider: 'openai', apiKey: 'sk-proj-x', model: 'gpt-6-luna', fetch: f.fn });

    const t1 = await s.start({ system: 'SYS', history, tools });
    expect(t1.toolCalls).toEqual([{ id: 'call_1', name: 'registrar_lancamentos', input: ITENS }]);
    const t2 = await s.continue([{ call: t1.toolCalls[0], content: 'OK #1' }]);
    expect(t2.text).toBe('Lancei R$ 10,00.');

    const [r1, r2] = f.requests;
    expect(r1.url).toBe('https://api.openai.com/v1/responses');
    expect(r1.headers.authorization).toBe('Bearer sk-proj-x');
    expect(r1.body).toMatchObject({ model: 'gpt-6-luna', instructions: 'SYS', input: history });
    expect(r1.body.previous_response_id).toBeUndefined();
    expect(r1.body.tools[0]).toEqual({ type: 'function', name: 'registrar_lancamentos', description: 'Grava', parameters: tools[0].parameters, strict: false });
    expect(r2.body).toMatchObject({
      previous_response_id: 'resp_1',
      instructions: 'SYS',
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'OK #1' }]
    });
  });
});

describe('Gemini (generateContent)', () => {
  it('converte papéis, devolve o conteúdo do modelo intacto (com thoughtSignature) e responde com functionResponse', async () => {
    const modelContent = {
      role: 'model',
      parts: [{ functionCall: { id: 'fc-9', name: 'registrar_lancamentos', args: ITENS }, thoughtSignature: 'ASSINATURA' }]
    };
    const f = fakeFetch([
      { body: { candidates: [{ content: modelContent }] } },
      { body: { candidates: [{ content: { role: 'model', parts: [{ text: 'pensando', thought: true }, { text: 'Lancei R$ 10,00.' }] } }] } }
    ]);
    const s = createProviderSession({ provider: 'gemini', apiKey: 'AIza-x', model: 'gemini-3.8-flash', fetch: f.fn });

    const t1 = await s.start({
      system: 'SYS',
      history: [...history, { role: 'assistant', content: 'Lancei.' }, { role: 'user', content: 'e 5 no pão' }],
      tools
    });
    expect(t1.toolCalls).toEqual([{ id: 'fc-9', name: 'registrar_lancamentos', input: ITENS }]);
    const t2 = await s.continue([{ call: t1.toolCalls[0], content: 'OK #1' }]);
    expect(t2.text).toBe('Lancei R$ 10,00.');

    const [r1, r2] = f.requests;
    expect(r1.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(r1.headers['x-goog-api-key']).toBe('AIza-x');
    expect(r1.body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(r1.body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(r1.body.tools).toEqual([{ functionDeclarations: [{ name: 'registrar_lancamentos', description: 'Grava', parameters: tools[0].parameters }] }]);
    expect(r2.body.contents.at(-2)).toEqual(modelContent);
    expect(r2.body.contents.at(-1)).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'fc-9', name: 'registrar_lancamentos', response: { result: 'OK #1' } } }]
    });
  });
});

describe('erros e validação de chave', () => {
  it.each([
    [401, { error: { message: 'invalid x-api-key' } }, 'auth'],
    [429, { error: { message: 'Rate limit' } }, 'quota'],
    [400, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 'quota'],
    [404, { error: { message: 'model not found' } }, 'model'],
    [500, { error: { message: 'boom' } }, 'unavailable']
  ])('HTTP %i vira erro "%s"', async (status, body, kind) => {
    const f = fakeFetch([{ status, body }]);
    const s = createProviderSession({ provider: 'openai', apiKey: 'k', model: 'm', fetch: f.fn });
    await expect(s.start({ system: '', history, tools })).rejects.toMatchObject({ kind });
  });

  it.each([
    ['claude', 'https://api.anthropic.com/v1/models?limit=1', 'x-api-key'],
    ['openai', 'https://api.openai.com/v1/models', 'authorization'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', 'x-goog-api-key']
  ] as const)('%s confere a chave listando modelos (sem gastar tokens)', async (provider, url, header) => {
    const ok = fakeFetch([{ body: { data: [] } }]);
    await verifyApiKey(provider, 'chave', ok.fn);
    expect(ok.requests[0].url).toBe(url);
    expect(ok.requests[0].headers[header]).toContain('chave');

    const bad = fakeFetch([{ status: 401, body: {} }]);
    await expect(verifyApiKey(provider, 'chave', bad.fn)).rejects.toBeInstanceOf(ProviderError);
  });
});
