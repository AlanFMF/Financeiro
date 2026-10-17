import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { AuthProvider } from './auth';
import { App } from './App';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-500.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { isNativeApp } from './api';

// No APK os arquivos já vêm dentro do app; o service worker só serve para a versão web.
if (!isNativeApp) registerSW({ immediate: true });

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, gcTime: 7 * 24 * 3600_000, retry: 1, refetchOnWindowFocus: true } }
});

// Os últimos dados ficam guardados no aparelho: sem internet, o app abre mostrando o que já tinha.
const persister = createSyncStoragePersister({ storage: window.localStorage, key: 'saldo.cache', throttleTime: 2000 });
const PERSISTED = new Set(['categories', 'summary', 'history', 'transactions', 'budgets', 'review']);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 3600_000,
        buster: 'v1',
        dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status === 'success' && PERSISTED.has(String(q.queryKey[0])) }
      }}
    >
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </PersistQueryClientProvider>
  </React.StrictMode>
);
