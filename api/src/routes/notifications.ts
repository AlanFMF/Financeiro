import type { FastifyPluginAsync } from 'fastify';
import { alertMessage, takeAlerts } from '../lib/budgets.js';

const TIME_ZONE = process.env.APP_TIMEZONE ?? 'America/Sao_Paulo';
const currentMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date()).slice(0, 7);
const reais = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Id estável e positivo de 31 bits para a notificação do Android (a mesma notícia substitui a anterior). */
function notificationId(key: string) {
  let h = 0;
  for (const ch of key) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 2_000_000_000;
}

export interface PhoneNotification {
  id: number;
  title: string;
  body: string;
  kind: 'meta' | 'importados';
}

/**
 * Notificações para o celular. O app instalado pergunta aqui de tempos em tempos, em segundo plano,
 * com uma chave de escopo "notify" que só lê esta rota. Cada notícia é entregue uma vez:
 * - metas do mês que chegaram a 80% ou 100% (as mesmas que o app mostraria ao abrir);
 * - o que entrou do banco desde a última vez, esperando conferência.
 */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const userId = req.user.sub;
    const month = currentMonth();
    const out: PhoneNotification[] = [];

    for (const a of await takeAlerts(app.db, userId, month)) {
      out.push({
        id: notificationId(`meta:${a.categoryId}:${month}:${a.level}`),
        title: a.level === 100 ? `Meta de ${a.name} atingida` : `${a.pct}% da meta de ${a.name}`,
        body: alertMessage(a),
        kind: 'meta'
      });
    }

    // Importações novas desde o último aviso (a primeira chamada só marca o ponto de partida).
    const state = (
      await app.db.query<{ since: string }>(
        `insert into notification_state (user_id) values ($1)
         on conflict (user_id) do update set imports_notified_at = notification_state.imports_notified_at
         returning imports_notified_at as since`,
        [userId]
      )
    ).rows[0];
    const news = (
      await app.db.query<{ kind: 'entrada' | 'saida'; n: number; total: string | number; last: string | Date }>(
        `select c.kind, count(*)::int as n, sum(t.amount_cents)::int8 as total, max(t.created_at) as last
         from transactions t join categories c on c.id = t.category_id
         where t.user_id = $1 and t.source is not null and t.needs_review and t.created_at > $2
         group by c.kind`,
        [userId, state.since]
      )
    ).rows;
    if (news.length) {
      const out_ = news.find((r) => r.kind === 'saida');
      const in_ = news.find((r) => r.kind === 'entrada');
      const parts = [
        out_ && `${out_.n} ${out_.n === 1 ? 'gasto' : 'gastos'} (${reais(Number(out_.total))})`,
        in_ && `${in_.n} ${in_.n === 1 ? 'entrada' : 'entradas'} (${reais(Number(in_.total))})`
      ].filter(Boolean);
      const last = new Date(Math.max(...news.map((r) => new Date(r.last).getTime())));
      out.push({
        id: notificationId(`importados:${last.toISOString()}`),
        title: 'Lançamentos do banco',
        body: `Entraram ${parts.join(' e ')}. Toque para conferir as categorias.`,
        kind: 'importados'
      });
      await app.db.query('update notification_state set imports_notified_at = $2 where user_id = $1', [userId, last.toISOString()]);
    }

    return { notifications: out };
  });
};
