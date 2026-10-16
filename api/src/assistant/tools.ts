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
  updated: CreatedTransaction[];
  deleted: CreatedTransaction[];
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
    name: 'corrigir_lancamento',
    description:
      'Corrige um lançamento já gravado quando o usuário pedir ("na verdade foi 50", "era Lazer, não Compras", "foi ontem"). Use o id da lista de lançamentos recentes ou de consultar_lancamentos. Envie só os campos que mudam.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Id do lançamento' },
        tipo: { type: 'string', enum: ['saida', 'entrada'] },
        categoria: { type: 'string' },
        valor: { type: 'number', description: 'Novo valor em reais' },
        data: { type: 'string', description: 'AAAA-MM-DD' },
        descricao: { type: 'string' },
        fixo: { type: 'boolean' }
      },
      required: ['id']
    }
  },
  {
    name: 'excluir_lancamento',
    description:
      'Apaga um lançamento só quando o usuário pedir claramente ("apaga o do uber", "esse eu lancei errado, tira"). Nunca apague por iniciativa própria nem vários de uma vez sem o usuário listar quais.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Id do lançamento' } },
      required: ['id']
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
  if (!n) return sameKind.find((c) => normalize(c.name) === (kind === 'entrada' ? 'outras receitas' : 'imprevistos/outros')) ?? sameKind[0];
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

  if (name === 'corrigir_lancamento' || name === 'excluir_lancamento') {
    const id = Number(input.id);
    const current = Number.isInteger(id)
      ? (await ctx.db.query<CreatedTransaction>(`${TX_SELECT} where t.id = $1 and t.user_id = $2`, [id, ctx.userId])).rows[0]
      : undefined;
    if (!current) return { content: `Lançamento #${input.id} não encontrado. Use consultar_lancamentos para achar o id.`, isError: true };

    if (name === 'excluir_lancamento') {
      await ctx.db.query('delete from transactions where id = $1 and user_id = $2', [id, ctx.userId]);
      ctx.deleted.push(current);
      ctx.created = ctx.created.filter((t) => t.id !== id);
      return { content: `Excluído #${id}: ${current.kind} ${reais(current.amountCents)} em ${current.categoryName}, "${current.description}", ${current.date}` };
    }

    const kind = input.tipo === 'entrada' || input.tipo === 'saida' ? input.tipo : current.kind;
    let categoryId = current.categoryId;
    if (typeof input.categoria === 'string' && input.categoria) {
      const cat = findCategory(ctx.categories, input.categoria, kind);
      if (cat) categoryId = cat.id;
    } else if (kind !== current.kind) {
      const cat = findCategory(ctx.categories, '', kind);
      if (cat) categoryId = cat.id;
    }
    let amountCents = current.amountCents;
    if (input.valor !== undefined) {
      amountCents = Math.round(Number(input.valor) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 1_000_000_000) {
        return { content: `Valor inválido (${input.valor}).`, isError: true };
      }
    }
    const date = input.data !== undefined ? (isDate(input.data) ? input.data : null) : current.date;
    if (!date) return { content: `Data inválida (${input.data}). Use AAAA-MM-DD.`, isError: true };
    const description = typeof input.descricao === 'string' ? input.descricao.trim().slice(0, 120) : current.description;
    const isFixed = typeof input.fixo === 'boolean' ? input.fixo : current.isFixed;

    await ctx.db.query(
      `update transactions set category_id = $3, date = $4, description = $5, amount_cents = $6, is_fixed = $7, updated_at = now()
       where id = $1 and user_id = $2`,
      [id, ctx.userId, categoryId, date, description, amountCents, isFixed]
    );
    const tx = (await ctx.db.query<CreatedTransaction>(`${TX_SELECT} where t.id = $1`, [id])).rows[0];
    // Se foi criado nesta mesma conversa, atualiza o cartão em vez de mostrar dois.
    const createdIdx = ctx.created.findIndex((t) => t.id === id);
    if (createdIdx >= 0) ctx.created[createdIdx] = tx;
    else ctx.updated = [...ctx.updated.filter((t) => t.id !== id), tx];
    return {
      content: `Corrigido #${id}: agora ${tx.kind} ${reais(tx.amountCents)} em ${tx.categoryName}, "${tx.description}", ${tx.date}`
    };
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
        rows.map((r) => `#${r.id} | ${r.date} | ${r.kind} | ${r.categoryName} | ${r.description} | ${reais(r.amountCents)}`).join('\n') +
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
