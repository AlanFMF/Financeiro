import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type Category, type Kind } from '../api';
import { useAuth } from '../auth';
import { useCategories, useInvalidate } from '../queries';
import { useEditor } from '../components/Layout';
import { AiSettings } from '../components/AiSettings';
import { SyncSettings } from '../components/SyncSettings';

type InstallEvent = Event & { prompt: () => Promise<void> };

export function SettingsPage() {
  const { user, signOut } = useAuth();
  const { data: categories = [] } = useCategories();
  const { toast } = useEditor();
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [exportYear, setExportYear] = useState(new Date().getFullYear());
  const standalone = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches;

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  async function exportCsv() {
    try {
      const text = await api.text(`/export.csv?year=${exportYear}`);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `saldo-${exportYear}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="page narrow">
      <h1 className="page-title">Ajustes</h1>

      {!standalone && (
        <section className="panel">
          <h2>Usar como app no celular</h2>
          {installEvent ? (
            <button className="btn primary" onClick={() => installEvent.prompt().then(() => setInstallEvent(null))}>
              Instalar o Saldo
            </button>
          ) : (
            <p className="muted">
              No Android, abra no Chrome e toque em <strong>Instalar app</strong> no menu. No iPhone, abra no Safari, toque em
              Compartilhar e depois em <strong>Adicionar à Tela de Início</strong>.
            </p>
          )}
        </section>
      )}

      <AiSettings />
      {!user?.isDemo && <SyncSettings />}

      <CategoryManager kind="saida" title="Categorias de saída" categories={categories} />
      <CategoryManager kind="entrada" title="Categorias de entrada" categories={categories} />

      <section className="panel">
        <h2>Exportar</h2>
        <p className="muted">Baixa um CSV no formato da sua planilha: Data, Categoria, Descrição, Entrada e Saída.</p>
        <div className="inline-form">
          <label className="field">
            <span>Ano</span>
            <input type="number" min={2000} max={2100} value={exportYear} onChange={(e) => setExportYear(Number(e.target.value))} />
          </label>
          <button className="btn" onClick={exportCsv}>
            Baixar CSV de {exportYear}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Conta</h2>
        <p className="muted">{user?.isDemo ? 'Conta de demonstração com dados fictícios.' : `${user?.name}, ${user?.email}`}</p>
        <button className="btn" onClick={signOut}>
          Sair
        </button>
      </section>
    </div>
  );
}

function CategoryManager({ kind, title, categories }: { kind: Kind; title: string; categories: Category[] }) {
  const invalidate = useInvalidate();
  const { toast } = useEditor();
  const [name, setName] = useState('');
  const list = categories.filter((c) => c.kind === kind);

  const create = useMutation({
    mutationFn: () => api.post('/categories', { name: name.trim(), kind }),
    onSuccess: async () => {
      setName('');
      await invalidate();
      toast('Categoria criada');
    },
    onError: (e: Error) => toast(e.message)
  });

  const update = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; color?: string; archived?: boolean }) => api.patch(`/categories/${id}`, data),
    onSuccess: invalidate,
    onError: (e: Error) => toast(e.message)
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/categories/${id}`),
    onSuccess: async () => {
      await invalidate();
      toast('Categoria excluída');
    },
    onError: (e: Error) => toast(e.message)
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <section className="panel">
      <h2>{title}</h2>
      <ul className="cat-list">
        {list.map((c) => (
          <li key={c.id} data-archived={c.archived}>
            <label className="swatch" style={{ background: c.color }}>
              <span className="sr-only">Cor de {c.name}</span>
              <input type="color" value={c.color} onChange={(e) => update.mutate({ id: c.id, color: e.target.value })} />
            </label>
            <input
              className="cat-name"
              defaultValue={c.name}
              aria-label="Nome da categoria"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== c.name) update.mutate({ id: c.id, name: v });
              }}
            />
            <span className="cat-count tnum">{c.transactionCount}</span>
            {c.transactionCount === 0 ? (
              <button className="link-btn danger-text" onClick={() => remove.mutate(c.id)}>
                Excluir
              </button>
            ) : (
              <button className="link-btn" onClick={() => update.mutate({ id: c.id, archived: !c.archived })}>
                {c.archived ? 'Reativar' : 'Arquivar'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={submit}>
        <label className="field grow">
          <span className="sr-only">Nova categoria</span>
          <input value={name} maxLength={40} placeholder="Nova categoria" onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn" disabled={!name.trim() || create.isPending}>
          Adicionar
        </button>
      </form>
    </section>
  );
}
