import { Capacitor } from '@capacitor/core';

const TOKEN_KEY = 'saldo.token';
const SERVER_KEY = 'saldo.server';

/** true dentro do APK (Capacitor); false no navegador. */
export const isNativeApp = Capacitor.isNativePlatform();

const DEFAULT_SERVER = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/**
 * Endereço da API. No navegador é o mesmo site (ou VITE_API_URL). No APK vem do build
 * ou do que a pessoa digitou na tela de entrada, para trocar de servidor sem gerar outro APK.
 */
export const serverStore = {
  get(): string {
    try {
      return localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
    } catch {
      return DEFAULT_SERVER;
    }
  },
  set(url: string) {
    const clean = url.trim().replace(/\/+$/, '').replace(/\/api$/, '');
    try {
      if (clean && clean !== DEFAULT_SERVER) localStorage.setItem(SERVER_KEY, clean);
      else localStorage.removeItem(SERVER_KEY);
    } catch {
      /* sem armazenamento: usa o padrão */
    }
  },
  isDefault: () => serverStore.get() === DEFAULT_SERVER,
  hasDefault: Boolean(DEFAULT_SERVER)
};

const base = () => serverStore.get() + '/api';

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
    res = await fetch(base() + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(
      0,
      isNativeApp && !serverStore.get()
        ? 'Informe o endereço do servidor abaixo para entrar.'
        : 'Sem conexão com o servidor. Confira a internet e tente de novo.'
    );
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
  /** Meta mensal de gasto (só categorias de saída). */
  budgetCents: number | null;
}

export interface Budget {
  categoryId: number;
  name: string;
  color: string;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  pct: number;
  level: 0 | 80 | 100;
}

export interface BudgetAlert {
  categoryId: number;
  level: 80 | 100;
  message: string;
}

export interface Transaction {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  isFixed: boolean;
  /** "Nubank cartão", "Nubank conta"... quando veio da sincronização com o banco. */
  source?: string | null;
  /** Veio do banco e ainda não foi conferido. */
  needsReview?: boolean;
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
  /** Só no mês corrente: saldo previsto para o último dia. */
  forecast: Forecast | null;
}

export interface Forecast {
  endDate: string;
  daysLeft: number;
  balanceCents: number;
  pendingIncomeCents: number;
  pendingFixedExpenseCents: number;
  dailyVariableCents: number;
  remainingVariableCents: number;
  projectedBalanceCents: number;
  basis: 'historico' | 'mes_atual' | 'misto';
  pending: { description: string; categoryName: string; kind: Kind; amountCents: number }[];
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
