import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/server.js';
import type { AssistantOptions } from '../src/assistant/route.js';
import { transcribeAudio, type AudioClip, type ProviderConfig } from '../src/assistant/providers.js';
import { createTelegramClient } from '../src/telegram/client.js';
import { say, scriptedProvider, tool, type Recorded } from './ai-helpers.js';

const CHAT = '555';
let db: Db | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

interface Setup {
  /** IA conectada pelo usuário (com chave de teste). */
  ai?: { provider: 'gemini' | 'openai' | 'claude'; factory?: ReturnType<typeof scriptedProvider>['factory'] };
  fallback?: AssistantOptions['audioFallback'];
  heard?: string | Error;
}

async function setup({ ai, fallback, heard = 'gastei 45 no lanche' }: Setup = {}) {
  const d = await createPgliteDb();
  db = d;
  await migrate(d);
  const sent: string[] = [];
  const downloads: string[] = [];
  const transcribed: { config: ProviderConfig; audio: AudioClip }[] = [];
  const a = await buildApp({
    db: d,
    jwtSecret: 'test',
    rateLimit: false,
    assistant: {
      now: () => new Date('2026-10-19T15:00:00Z'),
      verifyKey: async () => {},
      ...(ai?.factory ? { providerFactory: ai.factory } : {}),
      ...(fallback ? { audioFallback: fallback } : {}),
      transcriber: async (config, audio) => {
        transcribed.push({ config, audio });
        if (heard instanceof Error) throw heard;
        return heard;
      }
    },
    telegram: {
      client: {
        sendMessage: async (_to, text) => void sent.push(text.replace(/\u00a0/g, ' ')),
        getMe: async () => ({ username: 'saldo_bot' }),
        setWebhook: async () => {},
        downloadFile: async (id) => (downloads.push(id), Buffer.from('OggS-fake'))
      }
    }
  });
  app = a;
  await a.ready();
  const r = await a.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Alan', email: 'alan@x.com', password: '12345678' } });
  const headers = { authorization: `Bearer ${r.json().token}` };
  if (ai) {
    const s = await a.inject({ method: 'PUT', url: '/api/assistant/settings', headers, payload: { provider: ai.provider, apiKey: `chave-do-usuario-${ai.provider}` } });
    expect(s.statusCode).toBe(200);
  }

  let id = 1;
  const post = async (message: object) => {
    await a.inject({
      method: 'POST',
      url: '/api/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'segredo-de-teste' },
      payload: { update_id: ++id, message: { message_id: id, chat: { id: Number(CHAT), type: 'private' }, ...message } }
    });
    await a.chatIdle();
    return sent.at(-1) ?? '';
  };
  const { code } = (await a.inject({ method: 'POST', url: '/api/telegram/code', headers })).json();
  await post({ text: `/start ${code}` });
  const voice = (extra: object = {}) => post({ voice: { file_id: 'voz-1', duration: 4, mime_type: 'audio/ogg', file_size: 9000, ...extra } });
  const list = async () => (await a.inject({ method: 'GET', url: '/api/transactions', headers })).json().transactions;
  const status = async () => (await a.inject({ method: 'GET', url: '/api/telegram', headers })).json().audio as boolean;
  return { sent, downloads, transcribed, voice, post, list, status };
}

async function teardown() {
  await app?.close();
  await db?.close();
  app = null;
  db = null;
}
afterEach(teardown);

describe('áudio no Telegram', () => {
  it('com o Gemini do usuário: baixa, transcreve com a chave dele e lança', async () => {
    const ai = scriptedProvider([
      () => tool('registrar_lancamentos', { itens: [{ tipo: 'saida', categoria: 'Alimentação', valor: 45, descricao: 'Lanche', data: '2026-10-19' }] }),
      () => say('Lancei R$ 45,00 em Alimentação.')
    ]);
    const t = await setup({ ai: { provider: 'gemini', factory: ai.factory } });
    expect(await t.status()).toBe(true);
    const reply = await t.voice();

    expect(t.downloads).toEqual(['voz-1']);
    expect(t.transcribed[0].config).toMatchObject({ provider: 'gemini', apiKey: 'chave-do-usuario-gemini' });
    expect(t.transcribed[0].audio).toEqual({ data: Buffer.from('OggS-fake'), mimeType: 'audio/ogg' });
    // A IA recebe o que foi falado, como se fosse texto.
    expect((ai.sessions[0] as Recorded).history.at(-1)).toEqual({ role: 'user', content: 'gastei 45 no lanche' });
    expect(reply).toMatch(/^🎙️ Ouvi: "gastei 45 no lanche"\n\nLancei R\$ 45,00 em Alimentação\./);
    expect(await t.list()).toHaveLength(1);
    // O histórico guarda a transcrição, não "[voice]".
    const row = (await db!.query<{ content: string }>("select content from chat_messages where role = 'user' order by created_at desc limit 1")).rows[0];
    expect(row.content).toBe('gastei 45 no lanche');
  });

  it('sem IA, com a chave do servidor: transcreve e o modo simples lança', async () => {
    const t = await setup({ fallback: { provider: 'gemini', apiKey: 'chave-do-servidor' }, heard: 'Paguei 150 de luz ontem.' });
    const reply = await t.voice();
    expect(t.transcribed[0].config).toMatchObject({ provider: 'gemini', apiKey: 'chave-do-servidor', model: 'gemini-3.8-flash' });
    expect(reply).toContain('Ouvi: "Paguei 150 de luz ontem."');
    expect(reply).toContain('Lancei R$ 150,00 em Moradia');
    expect((await t.list())[0]).toMatchObject({ amountCents: 15000, date: '2026-10-18' });
  });

  it('sem IA que ouve: explica e nem baixa o áudio', async () => {
    const semIa = await setup();
    expect(await semIa.status()).toBe(false);
    expect(await semIa.voice()).toContain('conecte o Gemini (tem uso gratuito) ou o ChatGPT');
    expect(semIa.downloads).toEqual([]);
    await teardown();

    const claude = await setup({ ai: { provider: 'claude' } });
    expect(await claude.voice()).toContain('a API do Claude ainda não recebe áudio');
    expect(claude.downloads).toEqual([]);
  });

  it('com Claude conectado e chave do servidor, o áudio usa a do servidor', async () => {
    const ai = scriptedProvider([() => say('Anotado: R$ 45,00 em Alimentação.')]);
    const t = await setup({ ai: { provider: 'claude', factory: ai.factory }, fallback: { provider: 'gemini', apiKey: 'chave-do-servidor' } });
    expect(await t.status()).toBe(true);
    const reply = await t.voice();
    expect(t.transcribed[0].config.apiKey).toBe('chave-do-servidor');
    expect(ai.sessions[0].config.provider).toBe('claude');
    expect(reply).toContain('Anotado');
  });

  it('áudio longo, mudo ou com falha recebe uma explicação', async () => {
    const t = await setup({ fallback: { provider: 'gemini', apiKey: 'k' }, heard: '  ' });
    expect(await t.voice({ duration: 300 })).toContain('longo demais');
    expect(t.downloads).toEqual([]);
    expect(await t.voice()).toContain('Não ouvi nenhuma fala');
    expect(await t.list()).toHaveLength(0);
  });

  it('erro da IA ao transcrever vira mensagem clara', async () => {
    const { ProviderError } = await import('../src/assistant/providers.js');
    const t = await setup({ ai: { provider: 'openai' }, heard: new ProviderError('quota', 'Sua conta do ChatGPT atingiu o limite de uso ou está sem créditos.') });
    expect(await t.voice()).toContain('atingiu o limite de uso');
  });

  it('arquivo de áudio (não só mensagem de voz) também vale', async () => {
    const t = await setup({ fallback: { provider: 'gemini', apiKey: 'k' } });
    await t.post({ audio: { file_id: 'musica-1', duration: 5, mime_type: 'audio/mpeg' } });
    expect(t.transcribed[0].audio.mimeType).toBe('audio/mpeg');
    expect(await t.list()).toHaveLength(1);
  });
});

describe('transcrição nas APIs', () => {
  const clip: AudioClip = { data: Buffer.from('OggS'), mimeType: 'audio/ogg' };

  it('Gemini: manda o áudio em base64 e ignora o raciocínio', async () => {
    let req: { url: string; body: any; headers: any } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      req = { url, body: JSON.parse(String(init.body)), headers: init.headers };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pensando', thought: true }, { text: ' gastei 12 de uber ' }] } }] }));
    }) as typeof fetch;
    const text = await transcribeAudio({ provider: 'gemini', apiKey: 'g', model: 'gemini-3.8-flash', fetch: f }, clip);
    expect(text).toBe('gastei 12 de uber');
    expect(req!.url).toContain('/models/gemini-3.8-flash:generateContent');
    expect(req!.headers['x-goog-api-key']).toBe('g');
    expect(req!.body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'audio/ogg', data: Buffer.from('OggS').toString('base64') } });
  });

  it('ChatGPT: usa o endpoint de transcrição com o arquivo', async () => {
    let form: FormData | null = null;
    let url = '';
    const f = (async (u: string, init: RequestInit) => {
      url = u;
      form = init.body as FormData;
      return new Response(JSON.stringify({ text: 'recebi 200 de pix' }));
    }) as typeof fetch;
    expect(await transcribeAudio({ provider: 'openai', apiKey: 'o', model: 'gpt-6-luna', fetch: f }, clip)).toBe('recebi 200 de pix');
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(form!.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form!.get('language')).toBe('pt');
    expect((form!.get('file') as File).name).toBe('audio.ogg');
  });

  it('ChatGPT: se o modelo de transcrição sumir, tenta o whisper-1', async () => {
    const models: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const model = String((init.body as FormData).get('model'));
      models.push(model);
      if (model !== 'whisper-1') return new Response(JSON.stringify({ error: { message: 'The model does not exist' } }), { status: 404 });
      return new Response(JSON.stringify({ text: 'ok' }));
    }) as typeof fetch;
    expect(await transcribeAudio({ provider: 'openai', apiKey: 'o', model: 'x', fetch: f }, clip)).toBe('ok');
    expect(models).toEqual(['gpt-4o-mini-transcribe', 'whisper-1']);
  });

  it('Claude não recebe áudio', async () => {
    await expect(transcribeAudio({ provider: 'claude', apiKey: 'c', model: 'x' }, clip)).rejects.toThrow('não ouve áudio');
  });

  it('Telegram: getFile e depois o download do arquivo', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_7.oga' } }));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const data = await createTelegramClient('123:abc', f).downloadFile('voz-1');
    expect([...data]).toEqual([1, 2, 3]);
    expect(urls).toEqual(['https://api.telegram.org/bot123:abc/getFile', 'https://api.telegram.org/file/bot123:abc/voice/file_7.oga']);
  });
});
