import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db.js';
import { normalize } from '../lib/csv.js';
import { MONTH_RE, monthStart } from '../lib/money.js';
import { TX_SELECT } from '../routes/transactions.js';

export interface CategoryRow {
  id: number;
  name: string;
  kind: 'entrada' | 'saida';
}

export interface CreatedTransaction {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  isFixed: boolean;
  categoryId: number;
  categoryName: string;
  kind: 'entrada' | 'saida';
  color: string;
}

export interface ToolContext {
  db: Db;
  userId: number;
  categories: CategoryRow[];
  today: string;
  created: CreatedTransaction[];
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'registrar_lancamentos',
    description:
      'Grava um ou mais lançamentos (gastos ou recebimentos) que o usuário contou. Use sempre que a mensagem trouxer valor e o que foi. Um item por valor citado.',
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tipo: { type: 'string', enum: ['saida', 'entrada'], description: 'saida = gasto/pagamento; entrada = recebimento' },
              categoria: { type: 'string', description: 'Nome exato de uma das categorias do usuário, do mesmo tipo' },
              valor: { type: 'number', description: 'Valor em reais, positivo. Ex.: 45.9 para R$ 45,90' },
              data: { type: 'string', description: 'AAAA-MM-DD. Use a data de hoje se o usuário não disser outra' },
              descricao: { type: 'string', description: 'Descrição curta com a primeira letra maiúscula. Ex.: "Mercado", "Gasolina"' },
              fixo: { type: 'boolean', description: 'true só se o usuário disser que se repete todo mês' }
            },
            required: ['tipo', 'categoria', 'valor', 'data', 'descricao']
          }
        }
      },
      required: ['itens']
    }
  },
  {
    name: 'consultar_lancamentos',
    description: 'Lista lançamentos já gravados para responder perguntas como "quanto paguei de luz?" ou "o que gastei ontem?".',
    input_schema: {
      type: 'object',
      properties: {
        mes: { type: 'string', description: 'AAAA-MM' },
        categoria: { type: 'string', description: 'Nome da categoria para filtrar' },
        busca: { type: 'string', description: 'Trecho da descrição' },
        limite: { type: 'number', description: 'Máximo de itens, até 40' }
      }
    }
  },
  {
    name: 'resumo_do_mes',
    description: 'Totais de entradas, saídas, saldo e total por categoria de um mês.',
    input_schema: {
      type: 'object',
      properties: { mes: { type: 'string', description: 'AAAA-MM' } },
      required: ['mes']
    }
  }
];

const reais = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function findCategory(categories: CategoryRow[], name: string, kind: 'entrada' | 'saida') {
  const n = normalize(name);
  const sameKind = categories.filter((c) => c.kind === kind);
  return (
    sameKind.find((c) => normalize(c.name) === n) ??
    sameKind.find((c) => normalize(c.name).includes(n) || n.includes(normalize(c.name))) ??
    sameKind.find((c) => normalize(c.name) === (kind === 'entrada' ? 'outras receitas' : 'imprevistos/outros')) ??
    sameKind[0]
  );
}

export async function insertTransaction(
  ctx: ToolContext,
  item: { kind: 'entrada' | 'saida'; category: string; amountCents: number; date: string; description: string; isFixed: boolean }
) {
  const cat = findCategory(ctx.categories, item.category, item.kind);
  if (!cat) throw new Error('Nenhuma categoria disponível para esse tipo.');
  const { rows } = await ctx.db.query<{ id: number }>(
    `insert into transactions (user_id, category_id, date, description, amount_cents, is_fixed)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [ctx.userId, cat.id, item.date, item.description.slice(0, 120), item.amountCents, item.isFixed]
  );
  const tx = (await ctx.db.query<CreatedTransaction>(`${TX_SELECT} where t.id = $1`, [rows[0].id])).rows[0];
  ctx.created.push(tx);
  return tx;
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

type Input = Record<string, unknown>;

/** Executa a ferramenta pedida pelo modelo e devolve o texto do tool_result. */
export async function runTool(name: string, input: Input, ctx: ToolContext): Promise<{ content: string; isError?: boolean }> {
  if (name === 'registrar_lancamentos') {
    const itens = Array.isArray(input.itens) ? (input.itens as Input[]) : [];
    if (!itens.length) return { content: 'Nenhum item recebido.', isError: true };
    if (itens.length > 20) return { content: 'Mande no máximo 20 itens por vez.', isError: true };
    const results: string[] = [];
    for (const it of itens) {
      const kind = it.tipo === 'entrada' ? 'entrada' : 'saida';
      const amountCents = Math.round(Number(it.valor) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 1_000_000_000) {
        results.push(`ERRO em "${it.descricao}": valor inválido (${it.valor}). Pergunte o valor ao usuário.`);
        continue;
      }
      const date = isDate(it.data) ? it.data : ctx.today;
      const tx = await insertTransaction(ctx, {
        kind,
        category: String(it.categoria ?? ''),
        amountCents,
        date,
        description: String(it.descricao ?? '').trim(),
        isFixed: it.fixo === true
      });
      results.push(`OK #${tx.id}: ${tx.kind} ${reais(tx.amountCents)} em ${tx.categoryName}, "${tx.description}", ${tx.date}`);
    }
    return { content: results.join('\n') };
  }

  if (name === 'consultar_lancamentos') {
    const params: unknown[] = [ctx.userId];
    const where = ['t.user_id = $1'];
    if (typeof input.mes === 'string' && MONTH_RE.test(input.mes)) {
      params.push(monthStart(input.mes));
      where.push(`t.date >= $${params.length}::date and t.date < ($${params.length}::date + interval '1 month')`);
    }
    if (typeof input.categoria === 'string' && input.categoria) {
      params.push(`%${input.categoria}%`);
      where.push(`c.name ilike $${params.length}`);
    }
    if (typeof input.busca === 'string' && input.busca) {
      params.push(`%${input.busca}%`);
      where.push(`t.description ilike $${params.length}`);
    }
    const limit = Math.min(40, Math.max(1, Number(input.limite) || 20));
    params.push(limit);
    const { rows } = await ctx.db.query<CreatedTransaction>(
      `${TX_SELECT} where ${where.join(' and ')} order by t.date desc, t.id desc limit $${params.length}`,
      params
    );
    if (!rows.length) return { content: 'Nenhum lançamento encontrado com esses filtros.' };
    const total = rows.reduce((s, r) => s + (r.kind === 'entrada' ? r.amountCents : -r.amountCents), 0);
    return {
      content:
        rows.map((r) => `${r.date} | ${r.kind} | ${r.categoryName} | ${r.description} | ${reais(r.amountCents)}`).join('\n') +
        `\n${rows.length} itens (limite ${limit}). Resultado líquido: ${reais(total)}`
    };
  }

  if (name === 'resumo_do_mes') {
    if (typeof input.mes !== 'string' || !MONTH_RE.test(input.mes)) return { content: 'Mês inválido, use AAAA-MM.', isError: true };
    const { rows } = await ctx.db.query<{ name: string; kind: string; total: string | number }>(
      `select c.name, c.kind, sum(t.amount_cents)::int8 as total
       from transactions t join categories c on c.id = t.category_id
       where t.user_id = $1 and t.date >= $2::date and t.date < ($2::date + interval '1 month')
       group by c.name, c.kind order by c.kind, total desc`,
      [ctx.userId, monthStart(input.mes)]
    );
    const inc = rows.filter((r) => r.kind === 'entrada').reduce((s, r) => s + Number(r.total), 0);
    const out = rows.filter((r) => r.kind === 'saida').reduce((s, r) => s + Number(r.total), 0);
    return {
      content: [
        `Mês ${input.mes}: entradas ${reais(inc)}, saídas ${reais(out)}, saldo ${reais(inc - out)}`,
        ...rows.map((r) => `${r.kind} | ${r.name}: ${reais(Number(r.total))}`)
      ].join('\n')
    };
  }

  return { content: `Ferramenta desconhecida: ${name}`, isError: true };
}
