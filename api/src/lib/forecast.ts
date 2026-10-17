import type { Db } from '../db.js';
import { daysInMonth, monthStart, nextInstallment, shiftMonth } from './money.js';

/**
 * Previsão do saldo no último dia do mês atual:
 *   saldo de hoje
 *   + fixos de entrada do mês passado que ainda não entraram (salário, por exemplo)
 *   − fixos de saída do mês passado que ainda não saíram (aluguel, parcelas que continuam)
 *   − gastos do dia a dia nos dias que faltam, no ritmo de sempre.
 *
 * O ritmo do dia a dia mistura a média dos três meses anteriores com o ritmo deste mês, pesando mais
 * o mês atual conforme ele avança. Sem histórico, usa só o mês atual.
 */

export interface PendingFixed {
  description: string;
  categoryName: string;
  kind: 'entrada' | 'saida';
  amountCents: number;
}

export interface Forecast {
  month: string;
  today: string;
  endDate: string;
  daysLeft: number;
  balanceCents: number;
  pendingIncomeCents: number;
  pendingFixedExpenseCents: number;
  dailyVariableCents: number;
  remainingVariableCents: number;
  projectedBalanceCents: number;
  basis: 'historico' | 'mes_atual' | 'misto';
  pending: PendingFixed[];
}

type Row = {
  description: string;
  category_id: number;
  name: string;
  kind: 'entrada' | 'saida';
  amount_cents: number;
  is_fixed: boolean;
  date: string;
};

const sameMonth = (col: string, param: string) => `${col} >= ${param}::date and ${col} < (${param}::date + interval '1 month')`;

export async function monthForecast(db: Db, userId: number, month: string, today: string): Promise<Forecast | null> {
  if (!today.startsWith(month)) return null;
  const start = monthStart(month);
  const totalDays = daysInMonth(month);
  const day = Number(today.slice(8, 10));
  const daysLeft = totalDays - day;

  const totals = (
    await db.query<{ income: string | number; expense: string | number }>(
      `select coalesce(sum(t.amount_cents) filter (where c.kind = 'entrada'), 0)::int8 as income,
         coalesce(sum(t.amount_cents) filter (where c.kind = 'saida'), 0)::int8 as expense
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 and ${sameMonth('t.date', '$2')}`,
      [userId, start]
    )
  ).rows[0];
  const balanceCents = Number(totals.income) - Number(totals.expense);

  // Fixos do mês passado que ainda não apareceram neste mês (mesma categoria e mesma descrição,
  // ou valor quase igual: o aluguel que veio do banco com outro nome não conta duas vezes).
  const prev = (
    await db.query<Row>(
      `select t.description, t.category_id, c.name, c.kind, t.amount_cents, t.is_fixed, to_char(t.date, 'YYYY-MM-DD') as date
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 and t.is_fixed and ${sameMonth('t.date', '$2')}`,
      [userId, monthStart(shiftMonth(month, -1))]
    )
  ).rows;
  const current = (
    await db.query<Row>(
      `select t.description, t.category_id, c.name, c.kind, t.amount_cents, t.is_fixed, to_char(t.date, 'YYYY-MM-DD') as date
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 and ${sameMonth('t.date', '$2')}`,
      [userId, start]
    )
  ).rows;
  const used = new Set<number>();
  const pending: PendingFixed[] = [];
  for (const p of prev) {
    const next = nextInstallment(p.description);
    if (next === null) continue; // última parcela já foi
    const idx = current.findIndex(
      (c, i) =>
        !used.has(i) &&
        c.category_id === p.category_id &&
        (c.description.toLowerCase() === next.toLowerCase() || Math.abs(c.amount_cents - p.amount_cents) <= p.amount_cents * 0.02)
    );
    if (idx >= 0) {
      used.add(idx);
      continue;
    }
    pending.push({ description: next, categoryName: p.name, kind: p.kind, amountCents: p.amount_cents });
  }
  const pendingIncomeCents = pending.filter((p) => p.kind === 'entrada').reduce((s, p) => s + p.amountCents, 0);
  const pendingFixedExpenseCents = pending.filter((p) => p.kind === 'saida').reduce((s, p) => s + p.amountCents, 0);

  // Ritmo do dia a dia: gastos não fixos.
  const history = (
    await db.query<{ month: string; variable: string | number }>(
      `select to_char(date_trunc('month', t.date), 'YYYY-MM') as month, sum(t.amount_cents)::int8 as variable
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 and c.kind = 'saida' and not t.is_fixed
         and t.date >= $2::date and t.date < $3::date
       group by 1`,
      [userId, monthStart(shiftMonth(month, -3)), start]
    )
  ).rows;
  const histDays = history.reduce((s, h) => s + daysInMonth(h.month), 0);
  const histRate = histDays ? history.reduce((s, h) => s + Number(h.variable), 0) / histDays : null;
  // Neste mês, conta como dia a dia o que não é fixo nem fez o papel de um fixo (o aluguel que veio do banco).
  const curVariable = current.reduce(
    (sum, c, i) => (c.kind === 'saida' && !c.is_fixed && !used.has(i) && c.date <= today ? sum + c.amount_cents : sum),
    0
  );
  const curRate = curVariable / day;
  const f = day / totalDays;
  const rate = histRate === null ? curRate : histRate * (1 - f) + curRate * f;
  const dailyVariableCents = Math.round(rate);
  const remainingVariableCents = Math.round(rate * daysLeft);

  return {
    month,
    today,
    endDate: `${month}-${String(totalDays).padStart(2, '0')}`,
    daysLeft,
    balanceCents,
    pendingIncomeCents,
    pendingFixedExpenseCents,
    dailyVariableCents,
    remainingVariableCents,
    projectedBalanceCents: balanceCents + pendingIncomeCents - pendingFixedExpenseCents - remainingVariableCents,
    basis: histRate === null ? 'mes_atual' : day <= 3 ? 'historico' : 'misto',
    pending: pending.sort((a, b) => b.amountCents - a.amountCents)
  };
}

const reais = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Resposta pronta para "vou fechar o mês no azul?". */
export function forecastMessage(f: Forecast): string {
  const end = `${f.endDate.slice(8, 10)}/${f.endDate.slice(5, 7)}`;
  const head =
    f.projectedBalanceCents >= 0
      ? `Se o ritmo continuar, você fecha o mês com ${reais(f.projectedBalanceCents)} sobrando (previsão para ${end}).`
      : `Se o ritmo continuar, o mês fecha ${reais(-f.projectedBalanceCents)} no vermelho (previsão para ${end}).`;
  const parts = [`hoje o saldo é ${reais(f.balanceCents)}`];
  if (f.pendingIncomeCents) parts.push(`ainda devem entrar ${reais(f.pendingIncomeCents)} de fixos`);
  if (f.pendingFixedExpenseCents) parts.push(`faltam ${reais(f.pendingFixedExpenseCents)} de contas fixas`);
  if (f.daysLeft) parts.push(`e uns ${reais(f.remainingVariableCents)} no dia a dia (${reais(f.dailyVariableCents)} por dia)`);
  return `${head} Conta: ${parts.join(', ')}.`;
}
