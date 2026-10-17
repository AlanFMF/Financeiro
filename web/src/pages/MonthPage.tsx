import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, type Forecast, type HistoryPoint, type Summary } from '../api';
import { money, monthName, monthShort, percent, shiftMonth } from '../format';
import { useHistory, useInvalidate, useMonth, useSummary, useTransactions } from '../queries';
import { MonthSwitcher } from '../components/MonthSwitcher';
import { TransactionList } from '../components/TransactionList';
import { useEditor } from '../components/Layout';
import { BudgetPanel } from '../components/Budgets';
import { IconChevron } from '../components/Icons';
import { ReviewPanel } from '../components/ReviewPanel';

export function MonthPage() {
  const [month] = useMonth();
  const summary = useSummary(month);
  const history = useHistory(month);
  const txs = useTransactions({ month });
  const { open, toast } = useEditor();
  const invalidate = useInvalidate();
  const prev = shiftMonth(month, -1);

  const copyFixed = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number; finished: number }>('/transactions/copy-fixed', { from: prev, to: month }),
    onSuccess: async (r) => {
      await invalidate();
      if (r.created) toast(`${r.created} fixo${r.created > 1 ? 's' : ''} copiado${r.created > 1 ? 's' : ''} de ${monthName(prev)}`);
      else if (r.skipped) toast('Os fixos desse mês já estavam lançados');
      else toast(`Nenhum lançamento fixo em ${monthName(prev)}`);
    },
    onError: (e: Error) => toast(e.message)
  });

  const s = summary.data;
  const isEmpty = s && s.income === 0 && s.expense === 0;

  return (
    <div className="page month-page">
      <MonthSwitcher />

      {summary.isError && <p className="form-error">{(summary.error as Error).message}</p>}

      <div className="month-grid">
        <div className="col">
          <BalanceHero s={s} loading={summary.isLoading} />
          <ReviewPanel />
          <BudgetPanel month={month} />

          {isEmpty ? (
            <section className="panel empty-month">
              <h2>Nada lançado em {monthName(month)}</h2>
              <p>Comece pelos gastos que se repetem ou lance o primeiro valor do mês.</p>
              <div className="actions">
                <button className="btn primary" onClick={() => copyFixed.mutate()} disabled={copyFixed.isPending}>
                  Copiar fixos de {monthName(prev)}
                </button>
                <button className="btn" onClick={() => open()}>
                  Novo lançamento
                </button>
              </div>
            </section>
          ) : (
            s && <CategoryBreakdown s={s} />
          )}
        </div>

        <div className="col">
          {history.data && <HistoryChart series={history.data} current={month} />}

          <section className="panel">
            <div className="panel-head">
              <h2>Lançamentos do mês</h2>
              <Link to={`/lancamentos?mes=${month}`} className="link-btn">
                Ver todos
              </Link>
            </div>
            <TransactionList items={(txs.data ?? []).slice(0, 8)} empty={<p>Os lançamentos de {monthName(month)} aparecem aqui.</p>} />
            {!isEmpty && (
              <button className="link-btn copy-fixed" onClick={() => copyFixed.mutate()} disabled={copyFixed.isPending}>
                Copiar fixos de {monthName(prev)} para cá
              </button>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function BalanceHero({ s, loading }: { s?: Summary; loading: boolean }) {
  if (loading || !s) return <section className="hero skeleton" aria-busy="true" />;

  const used = percent(s.expense, s.income);
  const over = s.expense > s.income;
  const fill = s.income > 0 ? Math.min(100, (s.expense / s.income) * 100) : s.expense > 0 ? 100 : 0;
  const diff = s.expense - s.previous.expense;

  return (
    <section className="hero" aria-label="Saldo do mês">
      <p className="hero-label">Saldo do mês</p>
      <p className={`hero-value tnum ${s.balance < 0 ? 'neg' : ''}`}>
        {s.balance < 0 && '−'}
        {money(Math.abs(s.balance))}
      </p>

      <div className="regua" data-over={over} role="img" aria-label={`Saídas somam ${used}% das entradas`}>
        <span style={{ width: `${fill}%` }} />
      </div>
      <p className="regua-caption">
        {s.income === 0
          ? s.expense > 0
            ? 'Ainda não entrou nada este mês.'
            : ''
          : over
            ? `Saiu ${money(s.expense - s.income)} a mais do que entrou.`
            : `Saiu ${used}% do que entrou.`}
      </p>

      <dl className="hero-figures">
        <div>
          <dt>Entradas</dt>
          <dd className="tnum">{money(s.income)}</dd>
        </div>
        <div>
          <dt>Saídas</dt>
          <dd className="tnum">{money(s.expense)}</dd>
          {s.previous.expense > 0 && diff !== 0 && (
            <dd className="delta">
              {money(Math.abs(diff))} {diff > 0 ? 'a mais' : 'a menos'} que {monthName(shiftMonth(s.month, -1))}
            </dd>
          )}
        </div>
        {s.fixedExpense > 0 && (
          <div>
            <dt>Fixos</dt>
            <dd className="tnum">{money(s.fixedExpense)}</dd>
          </div>
        )}
      </dl>

      {s.forecast && s.forecast.daysLeft > 0 && <ForecastLine f={s.forecast} />}
    </section>
  );
}

/** Saldo previsto para o último dia, com a conta aberta num toque. */
function ForecastLine({ f }: { f: Forecast }) {
  const neg = f.projectedBalanceCents < 0;
  const end = `${Number(f.endDate.slice(8, 10))}/${f.endDate.slice(5, 7)}`;
  return (
    <details className="forecast" data-neg={neg}>
      <summary>
        <span className="forecast-label">
          Previsão para {end}
          <IconChevron className="forecast-chev" width={14} height={14} />
        </span>
        <span className="forecast-value tnum">
          {neg && '−'}
          {money(Math.abs(f.projectedBalanceCents))}
        </span>
      </summary>
      <dl className="forecast-math">
        <div>
          <dt>Saldo hoje</dt>
          <dd className="tnum">{money(f.balanceCents)}</dd>
        </div>
        {f.pendingIncomeCents > 0 && (
          <div>
            <dt>Fixos que ainda entram</dt>
            <dd className="tnum">+ {money(f.pendingIncomeCents)}</dd>
          </div>
        )}
        {f.pendingFixedExpenseCents > 0 && (
          <div>
            <dt>Fixos que ainda saem</dt>
            <dd className="tnum">− {money(f.pendingFixedExpenseCents)}</dd>
          </div>
        )}
        <div>
          <dt>
            Dia a dia ({money(f.dailyVariableCents)} por dia, {f.daysLeft} {f.daysLeft === 1 ? 'dia' : 'dias'})
          </dt>
          <dd className="tnum">− {money(f.remainingVariableCents)}</dd>
        </div>
      </dl>
      {f.pending.length > 0 && (
        <p className="forecast-pending muted">
          Fixos do mês passado que ainda não apareceram: {f.pending.slice(0, 4).map((p) => p.description || p.categoryName).join(', ')}
          {f.pending.length > 4 ? ` e mais ${f.pending.length - 4}` : ''}.
        </p>
      )}
    </details>
  );
}

function CategoryBreakdown({ s }: { s: Summary }) {
  const out = s.byCategory.filter((c) => c.kind === 'saida');
  const inc = s.byCategory.filter((c) => c.kind === 'entrada');
  const max = Math.max(1, ...out.map((c) => c.total));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Para onde foi</h2>
      </div>
      {out.length === 0 ? (
        <p className="muted">Nenhuma saída neste mês.</p>
      ) : (
        <ul className="bars">
          {out.map((c) => (
            <li key={c.id}>
              <Link to={`/lancamentos?mes=${s.month}&categoria=${c.id}`}>
                <span className="bar-name">{c.name}</span>
                <span className="bar-value tnum">{money(c.total)}</span>
                <span className="bar-pct tnum">{percent(c.total, s.expense)}%</span>
                <span className="bar-track">
                  <span style={{ width: `${(c.total / max) * 100}%`, background: c.color }} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {inc.length > 0 && (
        <>
          <h3 className="sub-head">De onde veio</h3>
          <ul className="income-list">
            {inc.map((c) => (
              <li key={c.id}>
                <span>{c.name}</span>
                <span className="tnum">{money(c.total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function HistoryChart({ series, current }: { series: HistoryPoint[]; current: string }) {
  const max = Math.max(1, ...series.flatMap((p) => [p.income, p.expense]));
  const W = 320;
  const H = 120;
  const slot = W / series.length;
  const bw = Math.min(14, slot / 3.2);
  const y = (v: number) => H - (v / max) * H;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Últimos {series.length} meses</h2>
        <p className="legend">
          <span className="key entrada" /> Entradas <span className="key saida" /> Saídas
        </p>
      </div>
      <svg className="history" viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label="Entradas e saídas por mês">
        <line x1="0" x2={W} y1={H} y2={H} className="axis" />
        {series.map((p, i) => {
          const cx = slot * i + slot / 2;
          return (
            <g key={p.month} className={p.month === current ? 'is-current' : ''}>
              <title>
                {monthName(p.month)}: entradas {money(p.income)}, saídas {money(p.expense)}
              </title>
              <rect x={cx - bw - 1.5} y={y(p.income)} width={bw} height={H - y(p.income)} rx="2" className="b-in" />
              <rect x={cx + 1.5} y={y(p.expense)} width={bw} height={H - y(p.expense)} rx="2" className="b-out" />
              <text x={cx} y={H + 16} textAnchor="middle">
                {monthShort(p.month)}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
