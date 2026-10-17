import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { createDefaultCategories } from './defaults.js';

/** Gerador determinístico para a demo ficar sempre parecida. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Dados 100% fictícios: 4 meses de uma pessoa que recebe salário,
 * paga aluguel, um financiamento parcelado, assinaturas e gastos do dia a dia.
 */
export async function createDemoUser(db: Db) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number; name: string; email: string; is_demo: boolean }>(
      `insert into users (name, email, password_hash, is_demo)
       values ('Visitante', $1, '!', true) returning id, name, email, is_demo`,
      [`demo-${randomUUID()}@saldo.demo`]
    );
    const user = rows[0];
    await createDefaultCategories(tx, user.id);

    const cats = await tx.query<{ id: number; name: string }>('select id, name from categories where user_id = $1', [user.id]);
    const cat = (name: string) => cats.rows.find((c) => c.name === name)!.id;

    const rand = rng(42);
    const today = new Date();
    const items: [string, number, string, number, boolean][] = [];

    for (let back = 3; back >= 0; back--) {
      const ref = new Date(today.getFullYear(), today.getMonth() - back, 1);
      const y = ref.getFullYear();
      const m = ref.getMonth() + 1;
      const lastDay = back === 0 ? today.getDate() : new Date(y, m, 0).getDate();
      const d = (day: number) => `${y}-${pad(m)}-${pad(Math.min(day, lastDay))}`;
      const parcela = 14 - back;

      items.push(
        [d(5), cat('Pró-labore/Salário'), 'Salário', 4850_00, true],
        [d(10), cat('Moradia'), 'Aluguel', 1350_00, true],
        [d(10), cat('Moradia'), 'Condomínio', 180_00, true],
        [d(12), cat('Moradia'), 'Energia', 210_00 + Math.round(rand() * 90_00), false],
        [d(15), cat('Contas'), 'Internet e celular', 159_90, true],
        [d(10), cat('Transporte'), `Financiamento moto (${parcela}/36)`, 689_40, true],
        [d(8), cat('Assinaturas'), 'Streaming de vídeo', 44_90, true],
        [d(8), cat('Assinaturas'), 'Streaming de música', 21_90, true],
        [d(20), cat('Educação'), 'Curso online', 89_00, true],
        [d(25), cat('Investimentos'), 'Reserva de emergência', 300_00, false]
      );
      if (rand() > 0.4) items.push([d(18), cat('Extra'), 'Freela de site', 600_00 + Math.round(rand() * 900_00), false]);

      for (let i = 0; i < 9; i++) {
        const day = 1 + Math.floor(rand() * lastDay);
        items.push([d(day), cat('Alimentação'), rand() > 0.5 ? 'Supermercado' : 'Padaria e feira', 30_00 + Math.round(rand() * 220_00), false]);
      }
      for (let i = 0; i < 3; i++) {
        items.push([d(1 + Math.floor(rand() * lastDay)), cat('Transporte'), 'Combustível', 120_00 + Math.round(rand() * 60_00), false]);
      }
      items.push(
        [d(1 + Math.floor(rand() * lastDay)), cat('Lazer'), 'Cinema e lanche', 60_00 + Math.round(rand() * 80_00), false],
        [d(1 + Math.floor(rand() * lastDay)), cat('Pet'), 'Ração', 140_00, false],
        [d(1 + Math.floor(rand() * lastDay)), cat('Cuidados pessoais'), 'Barbearia', 45_00, false]
      );
      if (rand() > 0.6) items.push([d(1 + Math.floor(rand() * lastDay)), cat('Saúde'), 'Farmácia', 35_00 + Math.round(rand() * 70_00), false]);
      if (rand() > 0.5) items.push([d(1 + Math.floor(rand() * lastDay)), cat('Compras'), 'Roupas', 120_00 + Math.round(rand() * 200_00), false]);
    }

    for (const [date, categoryId, description, amount, fixed] of items) {
      await tx.query(
        `insert into transactions (user_id, category_id, date, description, amount_cents, is_fixed)
         values ($1, $2, $3, $4, $5, $6)`,
        [user.id, categoryId, date, description, amount, fixed]
      );
    }
    // Metas de exemplo, para a demo já mostrar as barras e os avisos.
    for (const [name, cents] of [['Alimentação', 1500_00], ['Transporte', 1300_00], ['Lazer', 300_00]] as const) {
      await tx.query('update categories set budget_cents = $3 where user_id = $1 and name = $2', [user.id, name, cents]);
    }
    return user;
  });
}
