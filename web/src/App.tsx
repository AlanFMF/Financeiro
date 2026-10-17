import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { useSlow, WAKING_MESSAGE } from './useSlow';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { MonthPage } from './pages/MonthPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { ImportPage } from './pages/ImportPage';
import { SettingsPage } from './pages/SettingsPage';
import { NativeBackButton } from './backButton';

export function App() {
  const { user, loading } = useAuth();
  const slow = useSlow(loading);

  if (loading) {
    return (
      <div className="boot" aria-busy="true">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={56} height={56} />
        {slow && <p role="status">{WAKING_MESSAGE}</p>}
      </div>
    );
  }
  if (!user) {
    return (
      <>
        <NativeBackButton />
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </>
    );
  }

  return (
    <>
      <NativeBackButton />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<MonthPage />} />
          <Route path="lancamentos" element={<TransactionsPage />} />
          <Route path="importar" element={<ImportPage />} />
          <Route path="ajustes" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}
