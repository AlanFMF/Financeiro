import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Budget, type BudgetAlert, type Category } from '../api';
import { centsToInput, currentMonth, money, parseAmount } from '../format';
import { useBudgets, useInvalidate } from '../queries';
import { vibrate } from '../speech';
import { IconClose } from './Icons';

/** Barras das metas na tela do mês. */
export function BudgetPanel({ month }: { month: string }) {
  const { data, isLoading } = useBudgets(month);
  if (isLoading || !data) return null;

  if (!data.length) {
    return (
      <section className="panel budgets-empty">
        <div className="panel-head">
          <h2>Metas do mês</h2>
          <Link to="/ajustes#metas" className="link-btn">
            Definir metas
          </Link>
        </div>
        <p className="muted">Defina um limite por categoria e receba um aviso aos 80% e quando ele for atingido.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Metas do mês</h2>
        <Link to="/ajustes#metas" className="link-btn">
          Editar
        </Link>
      </div>
      <ul className="budgets">
        {data.map((b) => (
          <BudgetBar key={b.categoryId} b={b} month={month} />
        ))}
      </ul>
    </section>
  );
}

function BudgetBar({ b, month }: { b: Budget; month: string }) {
  const note =
    b.remainingCents > 0
      ? `Restam ${money(b.remainingCents)}`
      : b.remainingCents === 0
        ? 'Meta atingida'
        : `${money(-b.remainingCents)} acima da meta`;
  return (
    <li data-level={b.level}>
      <Link to={`/lancamentos?mes=${month}&categoria=${b.categoryId}`}>
        <span className="bar-name">{b.name}</span>
        <span className="budget-figures tnum">
          {money(b.spentCents)} <span className="muted">de {money(b.budgetCents)}</span>
        </span>
        <span className="bar-track budget-track" role="img" aria-label={`${b.name}: ${b.pct}% da meta`}>
          <span style={{ width: `${Math.min(100, b.pct)}%` }} />
        </span>
        <span className="budget-note">
          <span>{note}</span>
          <span className="tnum">{b.pct}%</span>
        </span>
      </Link>
    </li>
  );
}

/** Ajustes: um limite mensal por categoria de saída. Salva ao sair do campo ou com Enter. */
export function BudgetSettings({ categories }: { categories: Category[] }) {
  const out = categories.filter((c) => c.kind === 'saida' && !c.archived);
  return (
    <section className="panel" id="metas">
      <h2>Metas por categoria</h2>
      <p className="muted">
        Quanto você quer gastar no máximo por mês em cada categoria. O app avisa quando chegar a 80% e quando atingir. Deixe em branco
        para não ter meta.
      </p>
      <ul className="budget-settings">
        {out.map((c) => (
          <BudgetRow key={c.id} c={c} />
        ))}
      </ul>
    </section>
  );
}

function BudgetRow({ c }: { c: Category }) {
  const [value, setValue] = useState(c.budgetCents ? centsToInput(c.budgetCents) : '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const invalidate = useInvalidate();

  // Meta mudada em outro lugar (pelo assistente, por exemplo): atualiza o campo se ele não estiver em uso.
  useEffect(() => {
    if (document.activeElement?.id !== `meta-${c.id}`) setValue(c.budgetCents ? centsToInput(c.budgetCents) : '');
  }, [c.id, c.budgetCents]);

  async function save() {
    const text = value.trim();
    const cents = text ? parseAmount(text) : null;
    if (text && !cents) {
      setState('error');
      setError('Valor inválido');
      return;
    }
    if (cents === (c.budgetCents ?? null)) return;
    setState('saving');
    try {
      await api.put(`/budgets/${c.id}`, { budgetCents: cents });
      setState('saved');
      await invalidate();
    } catch (err) {
      setState('error');
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar');
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return (
    <li>
      <label htmlFor={`meta-${c.id}`}>
        <i className="dot" style={{ background: c.color }} aria-hidden="true" />
        {c.name}
      </label>
      <span className="money-input">
        <span aria-hidden="true">R$</span>
        <input
          id={`meta-${c.id}`}
          inputMode="decimal"
          placeholder="Sem meta"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setState('idle');
          }}
          onBlur={save}
          onKeyDown={onKeyDown}
          aria-invalid={state === 'error'}
          aria-describedby={`meta-${c.id}-status`}
        />
      </span>
      <small id={`meta-${c.id}-status`} className={`budget-status ${state}`} role="status">
        {state === 'saving' ? 'Salvando…' : state === 'saved' ? 'Salvo' : state === 'error' ? error : ''}
      </small>
    </li>
  );
}

/**
 * Avisos de meta (80% e 100%). O servidor entrega cada aviso uma vez só; aqui ele fica na tela até ser fechado.
 * Busca ao abrir o app, ao voltar para ele e depois de qualquer lançamento — inclusive os que chegaram do banco.
 */
export function BudgetAlerts() {
  const [items, setItems] = useState<BudgetAlert[]>([]);
  const alerts = useQuery({
    queryKey: ['budget-alerts'],
    queryFn: () => api.post<{ alerts: BudgetAlert[] }>('/budgets/alerts', { month: currentMonth() }).then((r) => r.alerts),
    staleTime: 0,
    retry: false
  });

  useEffect(() => {
    const fresh = alerts.data ?? [];
    if (!fresh.length) return;
    setItems((prev) => [...prev.filter((p) => !fresh.some((f) => f.categoryId === p.categoryId)), ...fresh]);
    vibrate(fresh.some((a) => a.level === 100) ? 120 : 60);
  }, [alerts.data]);

  if (!items.length) return null;
  return (
    <div className="budget-alerts" role="alert">
      {items.map((a) => (
        <BudgetAlertCard key={`${a.categoryId}-${a.level}`} alert={a} onClose={() => setItems((s) => s.filter((x) => x !== a))} />
      ))}
    </div>
  );
}

export function BudgetAlertCard({ alert, onClose }: { alert: BudgetAlert; onClose?: () => void }) {
  return (
    <p className="budget-alert" data-level={alert.level}>
      <span className="budget-alert-tag">{alert.level === 100 ? 'Meta atingida' : '80% da meta'}</span>
      <span className="budget-alert-text">{alert.message}</span>
      {onClose && (
        <button type="button" className="icon-btn" aria-label="Fechar aviso" onClick={onClose}>
          <IconClose width={18} height={18} />
        </button>
      )}
    </p>
  );
}
