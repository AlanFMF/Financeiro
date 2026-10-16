import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { money, monthName } from '../format';
import { useCategories, useMonth, useTransactions } from '../queries';
import { MonthSwitcher } from '../components/MonthSwitcher';
import { TransactionList } from '../components/TransactionList';

export function TransactionsPage() {
  const [month] = useMonth();
  const [params, setParams] = useSearchParams();
  const categoryId = Number(params.get('categoria')) || undefined;
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const { data: categories = [] } = useCategories();
  const txs = useTransactions({ month, categoryId, q });

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const setCategory = (id: string) =>
    setParams(
      (p) => {
        if (id) p.set('categoria', id);
        else p.delete('categoria');
        return p;
      },
      { replace: true }
    );

  const items = txs.data ?? [];
  const total = items.reduce((s, t) => s + (t.kind === 'entrada' ? t.amountCents : -t.amountCents), 0);

  return (
    <div className="page">
      <MonthSwitcher />
      <div className="filters">
        <label className="field grow">
          <span className="sr-only">Buscar</span>
          <input type="search" placeholder="Buscar por descrição ou categoria" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="field">
          <span className="sr-only">Categoria</span>
          <select value={categoryId ?? ''} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Todas as categorias</option>
            <optgroup label="Saídas">
              {categories.filter((c) => c.kind === 'saida').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Entradas">
              {categories.filter((c) => c.kind === 'entrada').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      </div>

      {items.length > 0 && (
        <p className="list-total">
          {items.length} lançamento{items.length > 1 ? 's' : ''}, resultado{' '}
          <strong className="tnum">
            {total < 0 ? '−' : '+'} {money(Math.abs(total))}
          </strong>
        </p>
      )}

      <section className="panel">
        {txs.isLoading ? (
          <div className="skeleton list-skeleton" aria-busy="true" />
        ) : (
          <TransactionList
            items={items}
            empty={
              q || categoryId ? (
                <p>Nada encontrado com esse filtro em {monthName(month)}.</p>
              ) : (
                <p>Nenhum lançamento em {monthName(month)}. Toque em + para lançar.</p>
              )
            }
          />
        )}
      </section>
    </div>
  );
}
