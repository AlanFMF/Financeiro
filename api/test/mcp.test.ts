import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let user: Awaited<ReturnType<typeof ctx.register>>;
let base: string;

beforeEach(async () => {
  ctx = await setup();
  user = await ctx.register('mcp@x.com');
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(() => ctx.close());

const createKey = async (scope: 'mcp' | 'sync', headers = user.headers) =>
  (await ctx.app.inject({ method: 'POST', url: '/api/tokens', headers, payload: { name: 'Claude', scope } })).json().token as string;

async function connect(key: string, viaPath = false) {
  const url = new URL(viaPath ? `${base}/mcp/${key}` : `${base}/mcp`);
  const client = new Client({ name: 'teste', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: viaPath ? {} : { headers: { authorization: `Bearer ${key}` } }
  });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '').replace(/\s/g, ' ');
const list = async () => (await ctx.app.inject({ method: 'GET', url: '/api/transactions', headers: user.headers })).json().transactions;

describe('conector do Claude (MCP)', () => {
  it('lista as ferramentas e manda as categorias do usuário nas instruções', async () => {
    const client = await connect(await createKey('mcp'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'registrar_lancamentos',
      'corrigir_lancamento',
      'excluir_lancamento',
      'consultar_lancamentos',
      'consultar_metas',
      'definir_meta',
      'resumo_do_mes'
    ]);
    expect(tools.find((t) => t.name === 'excluir_lancamento')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'resumo_do_mes')?.annotations?.readOnlyHint).toBe(true);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('- Alimentação (mercado');
    expect(instructions).toContain(', hoje)');
    await client.close();
  });

  it('lança, consulta e avisa a meta pelo Claude', async () => {
    await ctx.app.inject({ method: 'PUT', url: `/api/budgets/${user.cat('Alimentação')}`, headers: user.headers, payload: { budgetCents: 100_00 } });
    const client = await connect(await createKey('mcp'));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

    const r = await client.callTool({
      name: 'registrar_lancamentos',
      arguments: { itens: [{ tipo: 'saida', categoria: 'Alimentação', valor: 85, data: today, descricao: 'Mercado' }] }
    });
    expect(text(r)).toMatch(/^OK #\d+: saida R\$ 85,00 em Alimentação, "Mercado"/);
    expect(text(r)).toContain('AVISO DE META: Você já usou 85% da meta de Alimentação');
    expect(await list()).toHaveLength(1);

    const q = await client.callTool({ name: 'consultar_metas', arguments: { categoria: 'mercado' } });
    expect(text(q)).toContain('Alimentação: ainda pode gastar R$ 15,00');
    await client.close();
  });

  it('a chave no caminho também funciona', async () => {
    const client = await connect(await createKey('mcp'), true);
    const r = await client.callTool({ name: 'resumo_do_mes', arguments: { mes: '2026-10' } });
    expect(text(r)).toContain('Mês 2026-10');
    await client.close();
  });

  it('recusa sem chave, com chave revogada e com chave de sincronização', async () => {
    await expect(connect('saldo_nao-existe')).rejects.toThrow();
    await expect(connect(await createKey('sync'))).rejects.toThrow();

    const key = await createKey('mcp');
    const tokens = (await ctx.app.inject({ method: 'GET', url: '/api/tokens', headers: user.headers })).json().tokens;
    await ctx.app.inject({ method: 'DELETE', url: `/api/tokens/${tokens[0].id}`, headers: user.headers });
    await expect(connect(key)).rejects.toThrow();
  });

  it('a chave do conector não serve para a API comum nem para a sincronização', async () => {
    const key = await createKey('mcp');
    const h = { authorization: `Bearer ${key}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/transactions', headers: h })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/sync/status', headers: h })).statusCode).toBe(403);
  });

  it('cada chave só enxerga a conta do dono', async () => {
    const other = await ctx.register('outro@x.com');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: other.headers,
      payload: { categoryId: other.cat('Lazer'), date: '2026-10-10', description: 'Cinema do outro', amountCents: 50_00 }
    });
    const client = await connect(await createKey('mcp'));
    const r = await client.callTool({ name: 'consultar_lancamentos', arguments: { busca: 'Cinema' } });
    expect(text(r)).toBe('Nenhum lançamento encontrado com esses filtros.');
    await client.close();
  });

  it('GET no endpoint responde 405', async () => {
    const key = await createKey('mcp');
    const res = await ctx.app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(405);
  });
});
