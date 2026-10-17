import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const api = { post: vi.fn(), put: vi.fn(), del: vi.fn(), get: vi.fn() };
vi.mock('../src/api', () => ({ api, ApiError }));

const { applyToCache, flushOutbox, hasPending, outbox, queueDelete, queueSave } = await import('../src/outbox');

const cats = [
  { id: 1, name: 'Alimentação', kind: 'saida', color: '#B5772E', position: 0, archived: false, transactionCount: 0, budgetCents: 100_00 },
  { id: 2, name: 'Salário', kind: 'entrada', color: '#2E6B4F', position: 1, archived: false, transactionCount: 0, budgetCents: null }
];
const existing = {
  id: 10,
  date: '2026-10-05',
  description: 'Padaria',
  amountCents: 20_00,
  isFixed: false,
  categoryId: 1,
  categoryName: 'Alimentação',
  kind: 'saida' as const,
  color: '#B5772E'
};

let qc: QueryClient;
beforeEach(() => {
  outbox.clear();
  vi.clearAllMocks();
  qc = new QueryClient();
  qc.setQueryData(['categories'], cats);
  qc.setQueryData(['transactions', { month: '2026-10' }], [existing]);
  qc.setQueryData(['transactions', { month: '2026-09' }], []);
  qc.setQueryData(['summary', '2026-10'], {
    month: '2026-10',
    income: 0,
    expense: 20_00,
    balance: -20_00,
    fixedExpense: 0,
    previous: { income: 0, expense: 0, balance: 0 },
    byCategory: [{ id: 1, name: 'Alimentação', kind: 'saida', color: '#B5772E', total: 20_00, count: 1 }],
    forecast: null
  });
  qc.setQueryData(['budgets', '2026-10'], [
    { categoryId: 1, name: 'Alimentação', color: '#B5772E', budgetCents: 100_00, spentCents: 20_00, remainingCents: 80_00, pct: 20, level: 0 }
  ]);
});

const list = (month = '2026-10') => qc.getQueryData<{ id: number; pending?: boolean; amountCents: number }[]>(['transactions', { month }])!;
const summary = () => qc.getQueryData<{ expense: number; balance: number; byCategory: { id: number; total: number }[] }>(['summary', '2026-10'])!;
const input = (over = {}) => ({ categoryId: 1, date: '2026-10-17', description: 'Mercado', amountCents: 65_00, isFixed: false, ...over });

describe('fila de lançamentos sem internet', () => {
  it('lançamento novo aparece na hora, com totais e meta atualizados', () => {
    const tx = queueSave(qc, input());
    expect(tx.id).toBeLessThan(0);
    expect(tx.pending).toBe(true);
    expect(list().map((t) => t.id)).toEqual([tx.id, 10]);
    expect(list('2026-09')).toEqual([]);
    expect(summary()).toMatchObject({ expense: 85_00, balance: -85_00 });
    expect(summary().byCategory[0].total).toBe(85_00);
    expect(qc.getQueryData<{ pct: number; level: number }[]>(['budgets', '2026-10'])![0]).toMatchObject({ pct: 85, level: 80 });
    expect(outbox.items()).toHaveLength(1);
  });

  it('editar ou excluir o que ainda não subiu só mexe na fila', () => {
    const tx = queueSave(qc, input());
    expect(hasPending(tx.id)).toBe(true);
    queueSave(qc, { ...input({ amountCents: 70_00 }), id: tx.id });
    expect(outbox.items()).toHaveLength(1);
    expect(outbox.items()[0]).toMatchObject({ op: 'create', data: { amountCents: 70_00 } });
    expect(summary().expense).toBe(90_00);

    queueDelete(qc, tx.id);
    expect(outbox.items()).toEqual([]);
    expect(list().map((t) => t.id)).toEqual([10]);
    expect(summary().expense).toBe(20_00);
  });

  it('edição e exclusão de lançamento que já existe vão para a fila, sem repetir', () => {
    queueSave(qc, { ...input({ amountCents: 25_00, description: 'Padaria' }), id: 10 });
    queueSave(qc, { ...input({ amountCents: 30_00, description: 'Padaria' }), id: 10 });
    expect(outbox.items().map((i) => i.op)).toEqual(['update']);
    expect(summary().expense).toBe(30_00);
    queueDelete(qc, 10);
    expect(outbox.items().map((i) => i.op)).toEqual(['delete']);
    expect(list()).toEqual([]);
    expect(summary().expense).toBe(0);
  });

  it('envia em ordem com o clientId, e para quando a rede cai', async () => {
    queueSave(qc, input());
    queueSave(qc, input({ description: 'Feira' }));
    api.post.mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError(0, 'Sem conexão'));
    const r = await flushOutbox(qc);
    expect(r).toEqual({ synced: 1, failed: [], remaining: 1 });
    expect(api.post.mock.calls[0][1]).toMatchObject({ description: 'Mercado', clientId: expect.any(String) });
    expect(outbox.items()[0]).toMatchObject({ data: { description: 'Feira' } });

    api.post.mockResolvedValueOnce({});
    expect(await flushOutbox(qc)).toEqual({ synced: 1, failed: [], remaining: 0 });
  });

  it('o que o servidor recusa sai da fila e é relatado; exclusão de algo que já sumiu conta como feita', async () => {
    queueSave(qc, input({ categoryId: 999, description: 'Categoria apagada' }));
    queueDelete(qc, 10);
    api.post.mockRejectedValueOnce(new ApiError(400, 'Categoria inválida.'));
    api.del.mockRejectedValueOnce(new ApiError(404, 'Lançamento não encontrado.'));
    const r = await flushOutbox(qc);
    expect(r.synced).toBe(0);
    expect(r.failed).toEqual(['"Categoria apagada" feito sem internet não pôde ser salvo: Categoria inválida.']);
    expect(r.remaining).toBe(0);
  });

  it('servidor fora do ar (5xx) ou sessão expirada mantém a fila', async () => {
    queueSave(qc, input());
    api.post.mockRejectedValueOnce(new ApiError(502, 'Bad gateway'));
    expect((await flushOutbox(qc)).remaining).toBe(1);
    api.post.mockRejectedValueOnce(new ApiError(401, 'Sessão expirada'));
    expect((await flushOutbox(qc)).remaining).toBe(1);
  });

  it('applyToCache respeita os filtros de cada lista', () => {
    qc.setQueryData(['transactions', { month: '2026-10', categoryId: 2 }], []);
    applyToCache(qc, null, { ...existing, id: -1, amountCents: 5_00 });
    expect(qc.getQueryData(['transactions', { month: '2026-10', categoryId: 2 }])).toEqual([]);
    expect(list().map((t) => t.id)).toEqual([10, -1]); // mesma data: o mais recente primeiro
  });
});
