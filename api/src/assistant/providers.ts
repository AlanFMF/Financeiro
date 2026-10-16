/**
 * Adaptadores para as IAs que o usuário pode conectar com a própria chave.
 * Todos expõem a mesma interface: começar uma conversa e continuar depois de executar as ferramentas pedidas.
 *
 * - Claude: Messages API (api.anthropic.com/v1/messages)
 * - ChatGPT: Responses API (api.openai.com/v1/responses), encadeada por previous_response_id
 * - Gemini: generateContent (generativelanguage.googleapis.com), devolvendo o conteúdo do modelo intacto
 *   para preservar as "thought signatures" dos modelos com raciocínio
 */

export type ProviderId = 'claude' | 'openai' | 'gemini';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema do objeto de entrada. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Turn {
  text: string;
  toolCalls: ToolCall[];
}

export interface ToolResult {
  call: ToolCall;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProviderSession {
  start(params: { system: string; history: ChatMessage[]; tools: ToolDef[] }): Promise<Turn>;
  continue(results: ToolResult[]): Promise<Turn>;
}

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export type ProviderFactory = (config: ProviderConfig) => ProviderSession;

export const PROVIDERS: Record<ProviderId, { label: string; defaultModel: string; models: string[] }> = {
  claude: { label: 'Claude', defaultModel: 'claude-haiku-5-5', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] },
  openai: { label: 'ChatGPT', defaultModel: 'gpt-6-luna', models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'] },
  gemini: {
    label: 'Gemini',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']
  }
};

/** Erro de uma IA externa, já com mensagem para o usuário. */
export class ProviderError extends Error {
  constructor(public kind: 'auth' | 'quota' | 'model' | 'unavailable' | 'other', message: string, public status?: number) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;

async function call(fetchFn: typeof fetch, label: string, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError('unavailable', `Não consegui falar com o ${label}. Tente de novo em instantes.`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* corpo não é JSON */
  }
  if (!res.ok) {
    const err = (body.error ?? {}) as { message?: string; type?: string; status?: string; code?: string };
    const detail = String(err.message ?? '').slice(0, 300);
    if (res.status === 401 || res.status === 403 || /api.?key|invalid.*key|permission/i.test(`${err.type} ${err.status} ${detail}`)) {
      throw new ProviderError('auth', `A chave do ${label} foi recusada. Confira em Ajustes, Assistente de IA.`, res.status);
    }
    if (res.status === 429 || /quota|rate.?limit|resource_exhausted|insufficient/i.test(`${err.type} ${err.status} ${err.code} ${detail}`)) {
      throw new ProviderError('quota', `Sua conta do ${label} atingiu o limite de uso ou está sem créditos.`, res.status);
    }
    if (res.status === 404 || /model/i.test(detail)) {
      throw new ProviderError('model', `O ${label} não reconheceu o modelo escolhido. Troque o modelo em Ajustes. (${detail})`, res.status);
    }
    if (res.status >= 500 || res.status === 529) throw new ProviderError('unavailable', `O ${label} está instável agora. Tente de novo em instantes.`, res.status);
    throw new ProviderError('other', `O ${label} recusou o pedido: ${detail || res.status}`, res.status);
  }
  return body;
}

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

// ------------------------------------------------------------------ Claude

function claudeSession({ apiKey, model, fetch: f = fetch }: ProviderConfig): ProviderSession {
  let system = '';
  let tools: unknown[] = [];
  const messages: { role: string; content: unknown }[] = [];
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

  async function send(): Promise<Turn> {
    const body = await call(f, 'Claude', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 1024, system, tools, messages })
    });
    const content = (body.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    messages.push({ role: 'assistant', content });
    return {
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, input: parseArgs(b.input) }))
    };
  }

  return {
    start(p) {
      system = p.system;
      tools = p.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      messages.push(...p.history.map((m) => ({ role: m.role, content: m.content })));
      return send();
    },
    continue(results) {
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.content, is_error: r.isError || undefined }))
      });
      return send();
    }
  };
}

// ------------------------------------------------------------------ ChatGPT (OpenAI Responses API)

function openaiSession({ apiKey, model, fetch: f = fetch }: ProviderConfig): ProviderSession {
  let instructions = '';
  let tools: unknown[] = [];
  let previousId: string | null = null;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };

  async function send(input: unknown[]): Promise<Turn> {
    const body = await call(f, 'ChatGPT', 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        instructions,
        input,
        tools,
        ...(previousId ? { previous_response_id: previousId } : {})
      })
    });
    previousId = String(body.id ?? '') || previousId;
    const output = (body.output ?? []) as {
      type: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      content?: { type: string; text?: string }[];
    }[];
    return {
      text: output
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('\n')
        .trim(),
      toolCalls: output.filter((o) => o.type === 'function_call').map((o) => ({ id: o.call_id!, name: o.name!, input: parseArgs(o.arguments) }))
    };
  }

  return {
    start(p) {
      instructions = p.system;
      tools = p.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
      return send(p.history.map((m) => ({ role: m.role, content: m.content })));
    },
    continue(results) {
      return send(results.map((r) => ({ type: 'function_call_output', call_id: r.call.id, output: r.isError ? `ERRO: ${r.content}` : r.content })));
    }
  };
}

// ------------------------------------------------------------------ Gemini (generateContent)

function geminiSession({ apiKey, model, fetch: f = fetch }: ProviderConfig): ProviderSession {
  let systemInstruction: unknown = null;
  let tools: unknown[] = [];
  const contents: { role: string; parts: Record<string, unknown>[] }[] = [];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };

  async function send(): Promise<Turn> {
    const body = await call(f, 'Gemini', url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ systemInstruction, contents, tools })
    });
    const candidate = ((body.candidates ?? []) as { content?: { role?: string; parts?: Record<string, unknown>[] } }[])[0];
    const content = candidate?.content ?? { role: 'model', parts: [] };
    // Devolve o conteúdo exatamente como veio, com thoughtSignature, como o Gemini exige no turno seguinte.
    contents.push({ role: 'model', parts: content.parts ?? [] });
    const parts = content.parts ?? [];
    return {
      text: parts
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join('\n')
        .trim(),
      toolCalls: parts
        .filter((p) => p.functionCall)
        .map((p, i) => {
          const fc = p.functionCall as { id?: string; name: string; args?: unknown };
          return { id: fc.id ?? `${fc.name}#${i}`, name: fc.name, input: parseArgs(fc.args) };
        })
    };
  }

  return {
    start(p) {
      systemInstruction = { parts: [{ text: p.system }] };
      tools = [{ functionDeclarations: p.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      contents.push(...p.history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })));
      return send();
    },
    continue(results) {
      contents.push({
        role: 'user',
        parts: results.map((r) => ({
          functionResponse: {
            ...(r.call.id.includes('#') ? {} : { id: r.call.id }),
            name: r.call.name,
            response: r.isError ? { error: r.content } : { result: r.content }
          }
        }))
      });
      return send();
    }
  };
}

export const createProviderSession: ProviderFactory = (config) => {
  if (config.provider === 'claude') return claudeSession(config);
  if (config.provider === 'openai') return openaiSession(config);
  return geminiSession(config);
};

/** Confere a chave listando os modelos: não gasta tokens. */
export async function verifyApiKey(provider: ProviderId, apiKey: string, fetchFn: typeof fetch = fetch) {
  const label = PROVIDERS[provider].label;
  if (provider === 'claude') {
    await call(fetchFn, label, 'https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    });
  } else if (provider === 'openai') {
    await call(fetchFn, label, 'https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${apiKey}` } });
  } else {
    await call(fetchFn, label, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': apiKey } });
  }
}
