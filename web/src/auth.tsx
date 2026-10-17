import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setUnauthorizedHandler, tokenStore, type User } from './api';
import { outbox } from './outbox';

const USER_KEY = 'saldo.user';
const cachedUser = (): User | null => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null');
  } catch {
    return null;
  }
};
const rememberUser = (u: User | null) => {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* sem armazenamento */
  }
};

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (token: string, user: User) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => Boolean(tokenStore.get()));

  const signOut = useCallback(() => {
    tokenStore.set(null);
    rememberUser(null);
    outbox.clear();
    setUser(null);
    qc.clear();
  }, [qc]);

  const signIn = useCallback(
    (token: string, u: User) => {
      qc.clear();
      tokenStore.set(token);
      rememberUser(u);
      setUser(u);
    },
    [qc]
  );

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    if (!tokenStore.get()) return;
    api
      .get<{ user: User }>('/auth/me')
      .then((r) => {
        rememberUser(r.user);
        setUser(r.user);
      })
      .catch((err) => {
        // Sem internet (ou servidor acordando com erro): entra com o usuário já conhecido. Só sai com 401.
        const known = cachedUser();
        if (known && !(err instanceof ApiError && err.status === 401)) setUser(known);
        else signOut();
      })
      .finally(() => setLoading(false));
  }, [signOut]);

  return <AuthContext.Provider value={{ user, loading, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
