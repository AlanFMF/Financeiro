const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '') + '/api';
const TOKEN_KEY = 'saldo.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* navegação privada: segue só em memória */
    }
  }
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public issues: { path: string; message: string }[] = []) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. Confira a internet e tente de novo.');
  }
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `Erro ${res.status}`, data.issues);
  }
  if (res.status === 204) return undefined as T;
  return (raw ? res.text() : res.json()) as Promise<T>;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: (p: string) => request<void>('DELETE', p),
  text: (p: string) => request<string>('GET', p, undefined, true)
};

export type Kind = 'entrada' | 'saida';

export interface User {
  id: number;
  name: string;
  email: string;
  isDemo: boolean;
}

export interface Category {
  id: number;
  name: string;
  kind: Kind;
  color: string;
  position: number;
  archived: boolean;
  transactionCount: number;
}

export interface Transaction {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  isFixed: boolean;
  categoryId: number;
  categoryName: string;
  kind: Kind;
  color: string;
}

export interface Summary {
  month: string;
  income: number;
  expense: number;
  balance: number;
  fixedExpense: number;
  previous: { income: number; expense: number; balance: number };
  byCategory: { id: number; name: string; kind: Kind; color: string; total: number; count: number }[];
}

export interface HistoryPoint {
  month: string;
  income: number;
  expense: number;
}

export interface ImportResult {
  dryRun: boolean;
  rows: { line: number; date: string; category: string; description: string; kind: Kind; amountCents: number }[];
  errors: { line: number; message: string }[];
  newCategories: { name: string; kind: Kind }[];
  totals: { income: number; expense: number };
  created: number;
  duplicates: number;
}
