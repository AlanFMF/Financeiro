import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { api, ApiError, type Budget, type Category, type Summary, type Transaction } from './api';

/**
 * Fila de lançamentos feitos sem internet.
 *
 * Lançar, editar ou excluir sem conexão grava a operação aqui (no localStorage, que sobrevive a fechar o app),
 * atualiza na hora as telas que já estão em cache e, quando a rede volta, envia tudo em ordem.
 * - Um lançamento novo ganha um id negativo na tela e um `clientId`; o servidor usa esse id para não duplicar
 *   se o envio for repetido.
 * - Editar ou excluir um lançamento que ainda está na fila só muda (ou tira) o item da fila.
 */

export interface TransactionInput {
  categoryId: number;
  date: string;
  description: string;
  amountCents: number;
  isFixed: boolean;
}

export type OutboxItem =
  | { key: string; op: 'create'; tempId: number; data: TransactionInput; at: number }
  | { key: string; op: 'update'; id: number; data: TransactionInput; at: number }
  | { key: string; op: 'delete'; id: number; at: number };

const STORE = 'saldo.outbox';

function read(): OutboxItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

let items: OutboxItem[] = read();
const listeners = new Set<() => void>();

function write(next: OutboxItem[]) {
  items = next;
  try {
    localStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    /* sem armazenamento: a fila vive só nesta sessão */
  }
  listeners.forEach((l) => l());
}

export const outbox = {
  items: () => items,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Para os testes e para sair da conta. */
  clear: () => write([])
};

/** Itens pendentes, para a tela reagir à fila. */
export const useOutbox = () => useSyncExternalStore(outbox.subscribe, outbox.items, outbox.items);

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Erro de rede (sem internet, servidor fora do ar): vale guardar na fila e tentar depois. */
export const isNetworkError = (err: unknown) => err instanceof ApiError && err.status === 0;
export const looksOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// ------------------------------------------------------------------ atualização otimista das telas

type Filters = { month?: string; categoryId?: number; q?: string };

function findCached(qc: QueryClient, id: number): Transaction | null {
  for (const [, data] of qc.getQueriesData<Transaction[]>({ queryKey: ['transactions'] })) {
    const hit = data?.find((t) => t.id === id);
    if (hit) return hit;
  }
  return null;
}

function toTransaction(qc: QueryClient, id: number, data: TransactionInput): Transaction {
  const cat = qc.getQueryData<Category[]>(['categories'])?.find((c) => c.id === data.categoryId);
  return {
    id,
    date: data.date,
    description: data.description,
    amountCents: data.amountCents,
    isFixed: data.isFixed,
    source: null,
    categoryId: data.categoryId,
    categoryName: cat?.name ?? 'Categoria',
    kind: cat?.kind ?? 'saida',
    color: cat?.color ?? '#5B6870',
    pending: true
  };
}

const matches = (t: Transaction, f: Filters) =>
  (!f.month || t.date.startsWith(f.month)) &&
  (!f.categoryId || t.categoryId === f.categoryId) &&
  (!f.q || `${t.description} ${t.categoryName}`.toLowerCase().includes(f.q.toLowerCase()));

const byDateDesc = (a: Transaction, b: Transaction) => (a.date === b.date ? Math.abs(b.id) - Math.abs(a.id) : a.date < b.date ? 1 : -1);

/** Soma (sign = 1) ou tira (sign = -1) um lançamento dos totais do mês e das metas em cache. */
function adjustTotals(qc: QueryClient, t: Transaction, sign: 1 | -1) {
  const month = t.date.slice(0, 7);
  const v = t.amountCents * sign;
  qc.setQueryData<Summary>(['summary', month], (s) => {
    if (!s) return s;
    const income = s.income + (t.kind === 'entrada' ? v : 0);
    const expense = s.expense + (t.kind === 'saida' ? v : 0);
    let byCategory = s.byCategory.map((c) => (c.id === t.categoryId ? { ...c, total: c.total + v, count: c.count + sign } : c));
    if (!byCategory.some((c) => c.id === t.categoryId) && sign > 0) {
      byCategory = [...byCategory, { id: t.categoryId, name: t.categoryName, kind: t.kind, color: t.color, total: v, count: 1 }];
    }
    byCategory = byCategory.filter((c) => c.count > 0).sort((a, b) => (a.kind === b.kind ? b.total - a.total : a.kind < b.kind ? -1 : 1));
    return {
      ...s,
      income,
      expense,
      balance: income - expense,
      fixedExpense: s.fixedExpense + (t.isFixed && t.kind === 'saida' ? v : 0),
      byCategory
    };
  });
  if (t.kind === 'saida') {
    qc.setQueryData<Budget[]>(['budgets', month], (list) =>
      list?.map((b) => {
        if (b.categoryId !== t.categoryId) return b;
        const spentCents = b.spentCents + v;
        const pct = Math.floor((spentCents * 100) / b.budgetCents);
        return { ...b, spentCents, remainingCents: b.budgetCents - spentCents, pct, level: pct >= 100 ? 100 : pct >= 80 ? 80 : 0 };
      })
    );
  }
}

/** Troca `before` por `after` nas listas e nos totais em cache (qualquer um dos dois pode faltar). */
export function applyToCache(qc: QueryClient, before: Transaction | null, after: Transaction | null) {
  for (const [key, data] of qc.getQueriesData<Transaction[]>({ queryKey: ['transactions'] })) {
    if (!data) continue;
    const filters = (key[1] ?? {}) as Filters;
    let next = before ? data.filter((t) => t.id !== before.id) : data;
    if (after && matches(after, filters)) next = [after, ...next.filter((t) => t.id !== after.id)].sort(byDateDesc);
    if (next !== data) qc.setQueryData(key, next);
  }
  if (before) adjustTotals(qc, before, -1);
  if (after) adjustTotals(qc, after, 1);
}

// ------------------------------------------------------------------ operações

/** Guarda um lançamento novo ou editado na fila e mostra na hora. */
export function queueSave(qc: QueryClient, input: TransactionInput & { id?: number }): Transaction {
  const { id, ...data } = input;
  const list = items;

  if (id === undefined) {
    const tempId = -Date.now();
    write([...list, { key: uuid(), op: 'create', tempId, data, at: Date.now() }]);
    const tx = toTransaction(qc, tempId, data);
    applyToCache(qc, null, tx);
    return tx;
  }

  const before = findCached(qc, id);
  if (id < 0) {
    // Ainda não subiu: só troca os dados do item da fila.
    write(list.map((it) => (it.op === 'create' && it.tempId === id ? { ...it, data } : it)));
  } else {
    const rest = list.filter((it) => !(it.op === 'update' && it.id === id));
    write([...rest, { key: uuid(), op: 'update', id, data, at: Date.now() }]);
  }
  const after = toTransaction(qc, id, data);
  applyToCache(qc, before, after);
  return after;
}

/** Guarda uma exclusão na fila e tira da tela na hora. */
export function queueDelete(qc: QueryClient, id: number) {
  const before = findCached(qc, id);
  if (id < 0) {
    write(items.filter((it) => !(it.op === 'create' && it.tempId === id)));
  } else {
    const rest = items.filter((it) => !(it.op === 'update' && it.id === id));
    write([...rest, { key: uuid(), op: 'delete', id, at: Date.now() }]);
  }
  applyToCache(qc, before, null);
}

/** Se este lançamento tem algo pendente na fila, a próxima mudança nele também precisa passar pela fila. */
export const hasPending = (id: number | undefined) =>
  id !== undefined && (id < 0 || items.some((it) => it.op !== 'create' && it.id === id));

// ------------------------------------------------------------------ envio

export interface FlushResult {
  synced: number;
  failed: string[];
  /** Ainda há itens esperando (sem rede ou servidor fora). */
  remaining: number;
}

let running: Promise<FlushResult> | null = null;

/** Envia a fila em ordem. Para no primeiro erro de rede; descarta (e relata) o que o servidor recusar. */
export function flushOutbox(qc: QueryClient): Promise<FlushResult> {
  if (running) return running;
  running = (async () => {
    let synced = 0;
    const failed: string[] = [];
    for (const it of [...items]) {
      try {
        if (it.op === 'create') await api.post('/transactions', { ...it.data, clientId: it.key });
        else if (it.op === 'update') await api.put(`/transactions/${it.id}`, it.data);
        else await api.del(`/transactions/${it.id}`);
        synced++;
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        // Já não existe no servidor: a exclusão está feita; a edição não tem mais o que editar.
        const gone = status === 404;
        if (status === 0 || status === 401 || status === 429 || status >= 500) break;
        if (!(gone && it.op === 'delete')) {
          const what = it.op === 'delete' ? 'Uma exclusão' : `"${it.data.description || 'Lançamento'}"`;
          failed.push(`${what} feito sem internet não pôde ser salvo: ${err instanceof Error ? err.message : 'erro'}`);
        }
      }
      write(items.filter((x) => x.key !== it.key));
    }
    if (synced || failed.length) {
      await Promise.all(
        ['transactions', 'summary', 'history', 'categories', 'budgets', 'budget-alerts', 'review'].map((k) =>
          qc.invalidateQueries({ queryKey: [k] })
        )
      );
    }
    return { synced, failed, remaining: items.length };
  })().finally(() => {
    running = null;
  });
  return running;
}
