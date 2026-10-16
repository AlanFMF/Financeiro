import { currentMonth, monthLabel, shiftMonth } from '../format';
import { useMonth } from '../queries';
import { IconChevron } from './Icons';

export function MonthSwitcher() {
  const [month, setMonth] = useMonth();
  const isCurrent = month === currentMonth();
  return (
    <div className="month-switcher">
      <button className="icon-btn" aria-label="Mês anterior" onClick={() => setMonth(shiftMonth(month, -1))}>
        <IconChevron dir="left" />
      </button>
      <h1 className="month-title">{monthLabel(month)}</h1>
      <button className="icon-btn" aria-label="Próximo mês" onClick={() => setMonth(shiftMonth(month, 1))}>
        <IconChevron />
      </button>
      {!isCurrent && (
        <button className="link-btn" onClick={() => setMonth(currentMonth())}>
          Voltar para hoje
        </button>
      )}
    </div>
  );
}
