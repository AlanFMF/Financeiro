import type { FastifyPluginAsync } from 'fastify';
import { onChange } from '../lib/events.js';

/**
 * GET /api/events: fluxo Server-Sent Events com um aviso a cada mudança nos dados do usuário.
 * O app abre com fetch (para mandar o Authorization) e mantém aberto; um comentário a cada 25 s evita
 * que proxies derrubem a conexão parada.
 */
export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      // Os cabeçalhos de CORS já foram postos pela API antes do hijack.
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 5000\nevent: ready\ndata: {}\n\n');

    const stop = onChange(userId, (e) => res.write(`event: changed\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const close = () => {
      clearInterval(ping);
      stop();
    };
    req.raw.on('close', close);
    res.on('error', close);
  });
};
