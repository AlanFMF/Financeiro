import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useSearchParams } from 'react-router-dom';
import type { Transaction } from '../api';
import { useAuth } from '../auth';
import { IconImport, IconList, IconMonth, IconPlus, IconSettings } from './Icons';
import { TransactionSheet } from './TransactionSheet';
import { AssistantChat } from './AssistantChat';
import { BudgetAlerts } from './Budgets';

interface EditorState {
  open: (tx?: Transaction) => void;
  toast: (message: string) => void;
}
const EditorContext = createContext<EditorState>(null!);
export const useEditor = () => useContext(EditorContext);

const NAV = [
  { to: '/', label: 'Mês', icon: IconMonth, end: true },
  { to: '/lancamentos', label: 'Lançamentos', icon: IconList },
  { to: '/importar', label: 'Importar', icon: IconImport },
  { to: '/ajustes', label: 'Ajustes', icon: IconSettings }
];

export function Layout() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Transaction | null | undefined>(undefined);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  // Atalho do ícone instalado: "/?novo=1" já abre o formulário.
  useEffect(() => {
    if (params.get('novo')) {
      setEditing(null);
      params.delete('novo');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 2600);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const editor: EditorState = { open: (tx) => setEditing(tx ?? null), toast: setToastMsg };
  const keepMonth = params.get('mes') ? `?mes=${params.get('mes')}` : '';

  return (
    <EditorContext.Provider value={editor}>
      <div className="shell" data-chat={chatOpen}>
        <aside className="sidebar">
          <div className="brand">
            <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={32} height={32} />
            <span>Saldo</span>
          </div>
          <nav aria-label="Principal">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to + keepMonth} end={end} className="side-link">
                <Icon />
                {label}
              </NavLink>
            ))}
          </nav>
          <button className="btn primary side-add" onClick={() => editor.open()}>
            <IconPlus width={18} height={18} /> Novo lançamento
          </button>
          <p className="side-user">{user?.isDemo ? 'Conta de demonstração' : user?.name}</p>
        </aside>

        <main className="content">
          {user?.isDemo && (
            <p className="demo-banner">
              Você está na demonstração. Os dados são fictícios e somem em 24 horas.
            </p>
          )}
          <BudgetAlerts />
          <Outlet />
        </main>

        <button className="fab" aria-label="Novo lançamento" onClick={() => editor.open()}>
          <IconPlus />
        </button>

        <nav className="tabbar" aria-label="Principal">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to + keepMonth} end={end} className="tab">
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      <AssistantChat open={chatOpen} onOpenChange={setChatOpen} />

      {editing !== undefined && (
        <TransactionSheet
          transaction={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(msg) => {
            setEditing(undefined);
            setToastMsg(msg);
          }}
        />
      )}
      <div className="toast" role="status" aria-live="polite" data-show={Boolean(toastMsg)}>
        {toastMsg}
      </div>
    </EditorContext.Provider>
  );
}
