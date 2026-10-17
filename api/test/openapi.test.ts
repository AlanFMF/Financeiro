import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { openapi } from '../src/openapi.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());

describe('documentação da API', () => {
  it('toda rota da API está documentada, e nada documentado deixou de existir', () => {
    const toSpec = (url: string) => url.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';
    const ignored = new Set(['GET /openapi.json', 'GET /docs', 'GET /mcp', 'DELETE /mcp', 'POST /mcp/{key}', 'GET /mcp/{key}', 'DELETE /mcp/{key}']);
    const registered = new Set([...ctx.app.routeIndex].map((r) => r.replace(/ (\S+)$/, (_, u) => ` ${toSpec(u)}`)).filter((r) => !ignored.has(r)));
    const documented = new Set(
      Object.entries(openapi.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
    );
    expect([...registered].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !registered.has(r))).toEqual([]);
  });

  it('serve o JSON e a página', async () => {
    const spec = await ctx.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(spec.json().openapi).toBe('3.1.0');
    const page = await ctx.app.inject({ method: 'GET', url: '/docs' });
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('SwaggerUIBundle');
  });
});
