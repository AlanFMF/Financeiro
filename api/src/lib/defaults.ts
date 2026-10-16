import type { Db } from '../db.js';

export const DEFAULT_CATEGORIES: { name: string; kind: 'entrada' | 'saida'; color: string }[] = [
  { name: 'Pró-labore/Salário', kind: 'entrada', color: '#2E6B4F' },
  { name: 'Extra', kind: 'entrada', color: '#4F8A68' },
  { name: 'Outras receitas', kind: 'entrada', color: '#7FA48A' },
  { name: 'Moradia', kind: 'saida', color: '#1B3A4B' },
  { name: 'Contas', kind: 'saida', color: '#4A6C7A' },
  { name: 'Alimentação', kind: 'saida', color: '#B5772E' },
  { name: 'Transporte', kind: 'saida', color: '#5E7C4E' },
  { name: 'Saúde', kind: 'saida', color: '#8C2F39' },
  { name: 'Pet', kind: 'saida', color: '#9A6B4F' },
  { name: 'Assinaturas', kind: 'saida', color: '#5D5478' },
  { name: 'Educação', kind: 'saida', color: '#2F6F73' },
  { name: 'Lazer', kind: 'saida', color: '#C08A3E' },
  { name: 'Cuidados pessoais', kind: 'saida', color: '#A15C6E' },
  { name: 'Compras', kind: 'saida', color: '#7A6A4F' },
  { name: 'Investimentos', kind: 'saida', color: '#3C5A3A' },
  { name: 'Imprevistos/Outros', kind: 'saida', color: '#6E6E68' }
];

export async function createDefaultCategories(db: Db, userId: number) {
  for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
    await db.query(
      `insert into categories (user_id, name, kind, color, position) values ($1, $2, $3, $4, $5)
       on conflict (user_id, name, kind) do nothing`,
      [userId, c.name, c.kind, c.color, i]
    );
  }
}

/** Paleta usada quando a importação cria uma categoria nova. */
export const EXTRA_COLORS = ['#6A7F8C', '#8A7350', '#557A6E', '#7D5A6B', '#5F6F52', '#94704A'];
