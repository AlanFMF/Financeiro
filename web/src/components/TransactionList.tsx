import type { Transaction } from '../api';
import { dayLabel, money } from '../format';
import { IconCloudOff, IconRepeat } from './Icons';
import { useEditor } from './Layout';

export function TransactionList({ items, empty }: { items: Transaction[]; empty: React.ReactNode }) {
  const { open } = useEditor();
  if (!items.length) return <div className="empty">{empty}</div>;

  const groups = new Map<string, Transaction[]>();
  for (const t of items) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);

  return (
    <div className="tx-list">
      {[...groups].map(([date, txs]) => {
        const dayTotal = txs.reduce((s, t) => s + (t.kind === 'entrada' ? t.amountCents : -t.amountCents), 0);
        return (
          <section key={date} className="tx-day">
            <h3>
              <span>{dayLabel(date)}</span>
              <span className="tnum">{dayTotal >= 0 ? '+' : '−'} {money(Math.abs(dayTotal))}</span>
            </h3>
            <ul>
              {txs.map((t) => (
                <li key={t.id}>
                  <button className="tx" onClick={() => open(t)}>
                    <i className="dot" style={{ background: t.color }} aria-hidden="true" />
                    <span className="tx-main">
                      <span className="tx-desc">{t.description || t.categoryName}</span>
                      <span className="tx-cat">
                        {t.categoryName}
                        {t.source && <span className="bank-tag">{t.source}</span>}
                        {t.pending && (
                          <span className="pending-tag" title="Feito sem internet: sobe quando a conexão voltar">
                            <IconCloudOff /> no aparelho
                          </span>
                        )}
                        {t.isFixed && (
                          <span className="fixed" title="Repete todo mês">
                            <IconRepeat /> fixo
                          </span>
                        )}
                      </span>
                    </span>
                    <span className={`tx-value tnum ${t.kind}`}>
                      {t.kind === 'entrada' ? '+' : '−'} {money(t.amountCents)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
