import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, type Budget, type Category, type HistoryPoint, type Summary, type Transaction } from './api';
import { currentMonth, todayIso } from './format';
import { hasPending, isNetworkError, looksOffline, queueDelete, queueSave, type TransactionInput } from './outbox';

/** Mês selecionado fica na URL (?mes=2026-10), assim o botão voltar e o compartilhar funcionam. */
export function useMonth(): [string, (m: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('mes');
  const month = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : currentMonth();
  const setMonth = (m: string) =>
    setParams(
      (p) => {
        if (m === currentMonth()) p.delete('mes');
        else p.set('mes', m);
        return p;
      },
      { replace: true }
    );
  return [month, setMonth];
}

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: Category[] }>('/categories').then((r) => r.categories)
  });

export const useSummary = (month: string) =>
  useQuery({ queryKey: ['summary', month], queryFn: () => api.get<Summary>(`/summary?month=${month}&today=${todayIso()}`) });

export const useHistory = (month: string, months = 6) =>
  useQuery({
    queryKey: ['history', month, months],
    queryFn: () => api.get<{ series: HistoryPoint[] }>(`/summary/history?month=${month}&months=${months}`).then((r) => r.series)
  });

export const useBudgets = (month: string) =>
  useQuery({
    queryKey: ['budgets', month],
    queryFn: () => api.get<{ budgets: Budget[] }>(`/budgets?month=${month}`).then((r) => r.budgets)
  });

export const useReview = () =>
  useQuery({
    queryKey: ['review'],
    queryFn: () => api.get<{ transactions: Transaction[] }>('/transactions/review').then((r) => r.transactions)
  });

export const useTransactions = (filters: { month?: string; categoryId?: number; q?: string }) => {
  const qs = new URLSearchParams();
  if (filters.month) qs.set('month', filters.month);
  if (filters.categoryId) qs.set('categoryId', String(filters.categoryId));
  if (filters.q) qs.set('q', filters.q);
  return useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => api.get<{ transactions: Transaction[] }>(`/transactions?${qs}`).then((r) => r.transactions)
  });
};

/** Depois de qualquer escrita, recarrega tudo que depende de lançamentos. */
export function useInvalidate() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['transactions', 'summary', 'history', 'categories', 'budgets', 'budget-alerts', 'review'].map((k) => qc.invalidateQueries({ queryKey: [k] }))
    );
}

export type { TransactionInput };

/** Resultado de salvar: `queued` quando ficou na fila do aparelho por falta de internet. */
export type SaveResult = { queued: boolean };

/**
 * Salva um lançamento. Sem internet (ou se o servidor não responder), guarda na fila do aparelho,
 * mostra na hora e envia quando a conexão voltar.
 */
export function useSaveTransaction() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: TransactionInput & { id?: number }): Promise<SaveResult> => {
      if (looksOffline() || hasPending(input.id)) {
        queueSave(qc, input);
        return { queued: true };
      }
      const { id, ...data } = input;
      try {
        await (id ? api.put(`/transactions/${id}`, data) : api.post('/transactions', data));
        return { queued: false };
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        queueSave(qc, input);
        return { queued: true };
      }
    },
    onSuccess: (r) => (r.queued ? undefined : invalidate()),
    // Sem isso o TanStack pausa a mutação até a rede voltar; aqui quem decide o que fazer offline é a fila.
    networkMode: 'always'
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: number): Promise<SaveResult> => {
      if (looksOffline() || hasPending(id)) {
        queueDelete(qc, id);
        return { queued: true };
      }
      try {
        await api.del(`/transactions/${id}`);
        return { queued: false };
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        queueDelete(qc, id);
        return { queued: true };
      }
    },
    onSuccess: (r) => (r.queued ? undefined : invalidate()),
    networkMode: 'always'
  });
}
