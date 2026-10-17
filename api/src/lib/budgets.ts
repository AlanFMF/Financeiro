import type { Db } from '../db.js';
import { daysInMonth, monthStart } from './money.js';

/** Metas de gasto por categoria: limite mensal, quanto já foi gasto e em que faixa está. */

export type BudgetLevel = 0 | 80 | 100;

export interface BudgetStatus {
  categoryId: number;
  name: string;
  color: string;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  /** Porcentagem gasta, arredondada para baixo (79,9% ainda é 79). */
  pct: number;
  level: BudgetLevel;
}

export interface BudgetAlert extends BudgetStatus {
  level: 80 | 100;
}

export const ALERT_LEVELS = [80, 100] as const;

export function levelOf(spentCents: number, budgetCents: number): BudgetLevel {
  if (spentCents >= budgetCents) return 100;
  if (spentCents * 100 >= budgetCents * 80) return 80;
  return 0;
}

/** Situação das metas de um mês; só categorias de saída com meta definida. */
export async function budgetStatus(db: Db, userId: number, month: string, categoryIds?: number[]): Promise<BudgetStatus[]> {
  const params: unknown[] = [userId, monthStart(month)];
  let filter = '';
  if (categoryIds?.length) {
    params.push(categoryIds);
    filter = `and c.id = any($${params.length}::int[])`;
  }
  const { rows } = await db.query<{ categoryId: number; name: string; color: string; budgetCents: number; spent: string | number }>(
    `select c.id as "categoryId", c.name, c.color, c.budget_cents as "budgetCents",
       coalesce(sum(t.amount_cents), 0)::int8 as spent
     from categories c
     left join transactions t on t.category_id = c.id and t.user_id = c.user_id
       and t.date >= $2::date and t.date < ($2::date + interval '1 month')
     where c.user_id = $1 and c.kind = 'saida' and c.budget_cents is not null and not c.archived ${filter}
     group by c.id
     order by c.position, c.name`,
    params
  );
  return rows.map((r) => {
    const spentCents = Number(r.spent);
    return {
      categoryId: r.categoryId,
      name: r.name,
      color: r.color,
      budgetCents: r.budgetCents,
      spentCents,
      remainingCents: r.budgetCents - spentCents,
      pct: Math.floor((spentCents * 100) / r.budgetCents),
      level: levelOf(spentCents, r.budgetCents)
    };
  });
}

/** Metas que chegaram a 80% ou 100% no mês e cujo aviso ainda não foi dado (só o nível mais alto de cada). */
export async function pendingAlerts(db: Db, userId: number, month: string): Promise<BudgetAlert[]> {
  const status = (await budgetStatus(db, userId, month)).filter((s): s is BudgetAlert => s.level > 0);
  if (!status.length) return [];
  const { rows } = await db.query<{ categoryId: number; level: number }>(
    `select category_id as "categoryId", level from budget_alerts where user_id = $1 and month = $2`,
    [userId, month]
  );
  const seen = new Set(rows.map((r) => `${r.categoryId}:${r.level}`));
  return status.filter((s) => !seen.has(`${s.categoryId}:${s.level}`));
}

/** Marca os avisos como dados. Avisar os 100% também conta como ter avisado os 80%. */
export async function markAlertsSeen(db: Db, userId: number, month: string, alerts: { categoryId: number; level: number }[]) {
  for (const a of alerts) {
    for (const level of ALERT_LEVELS.filter((l) => l <= a.level)) {
      await db.query(
        `insert into budget_alerts (user_id, category_id, month, level)
         select $1, c.id, $3, $4 from categories c where c.id = $2 and c.user_id = $1
         on conflict do nothing`,
        [userId, a.categoryId, month, level]
      );
    }
  }
}

/** Busca os avisos pendentes e já os marca como dados. */
export async function takeAlerts(db: Db, userId: number, month: string): Promise<BudgetAlert[]> {
  const alerts = await pendingAlerts(db, userId, month);
  if (alerts.length) await markAlertsSeen(db, userId, month, alerts);
  return alerts;
}

const reais = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function alertMessage(a: BudgetAlert): string {
  if (a.level === 100) {
    const over = a.spentCents - a.budgetCents;
    return over > 0
      ? `Você passou da meta de ${a.name}: ${reais(a.spentCents)} de ${reais(a.budgetCents)} (${reais(over)} acima).`
      : `Você atingiu a meta de ${a.name}: ${reais(a.spentCents)} de ${reais(a.budgetCents)}.`;
  }
  return `Você já usou ${a.pct}% da meta de ${a.name}: ${reais(a.spentCents)} de ${reais(a.budgetCents)}. Restam ${reais(a.remainingCents)}.`;
}

/** Dias que faltam no mês, contando hoje. */
export function daysLeft(month: string, today: string): number {
  if (!today.startsWith(month)) return today < month ? daysInMonth(month) : 0;
  return daysInMonth(month) - Number(today.slice(8, 10)) + 1;
}

/** Resposta pronta para "quanto ainda posso gastar em X?". */
export function remainingMessage(s: BudgetStatus, today: string, month: string): string {
  if (s.remainingCents <= 0) {
    const over = -s.remainingCents;
    return over > 0
      ? `${s.name}: a meta de ${reais(s.budgetCents)} já estourou em ${reais(over)} (gasto ${reais(s.spentCents)}).`
      : `${s.name}: a meta de ${reais(s.budgetCents)} foi atingida. Qualquer gasto a mais passa do limite.`;
  }
  const days = daysLeft(month, today);
  const perDay = days > 1 ? ` Dá ${reais(Math.floor(s.remainingCents / days))} por dia até o fim do mês.` : '';
  return `${s.name}: ainda pode gastar ${reais(s.remainingCents)} (gastou ${reais(s.spentCents)} de ${reais(s.budgetCents)}, ${s.pct}%).${perDay}`;
}
