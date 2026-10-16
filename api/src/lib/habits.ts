import type { Db } from '../db.js';
import type { HistoryHint } from '../assistant/rules.js';

/** Para cada descrição, a categoria que o usuário mais usou com ela, das mais frequentes para as menos. */
export async function loadHabits(db: Db, userId: number): Promise<HistoryHint[]> {
  const { rows } = await db.query<{ description: string; category: string; kind: 'entrada' | 'saida'; total: string | number }>(
    `select distinct on (lower(t.description)) t.description, c.name as category, c.kind,
       sum(t.n) over (partition by lower(t.description)) as total
     from (
       select category_id, description, count(*) as n, max(date) as last
       from transactions
       where user_id = $1 and description <> ''
       group by category_id, description
     ) t join categories c on c.id = t.category_id
     order by lower(t.description), t.n desc, t.last desc`,
    [userId]
  );
  return rows
    .sort((a, b) => Number(b.total) - Number(a.total))
    .slice(0, 300)
    .map((r) => ({ description: r.description.replace(/\s*\(\d+\/\d+\)\s*$/, ''), category: r.category, kind: r.kind }));
}

