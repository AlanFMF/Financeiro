import { useState } from 'react';
import { api, ApiError, type Transaction } from '../api';
import { dayLabel, money } from '../format';
import { useCategories, useInvalidate, useReview } from '../queries';
import { useEditor } from './Layout';
import { IconCheck } from './Icons';

const PREVIEW = 5;

/**
 * Lançamentos que vieram do banco com a categoria escolhida pelo app. Trocar a categoria confirma o item,
 * leva junto os outros a conferir com a mesma descrição e ensina o app para as próximas importações.
 */
export function ReviewPanel() {
  const { data = [] } = useReview();
  const { data: categories = [] } = useCategories();
  const invalidate = useInvalidate();
  const { toast } = useEditor();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!data.length) return null;
  const visible = showAll ? data : data.slice(0, PREVIEW);

  async function run(work: () => Promise<string | void>) {
    setBusy(true);
    try {
      const msg = await work();
      await invalidate();
      if (msg) toast(msg);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  const change = (t: Transaction, categoryId: number) =>
    run(async () => {
      const r = await api.post<{ updated: number[] }>(`/transactions/review/${t.id}`, { categoryId });
      const name = categories.find((c) => c.id === categoryId)?.name ?? '';
      return r.updated.length > 1 ? `${r.updated.length} lançamentos de "${t.description}" foram para ${name}` : `Agora em ${name}`;
    });

  const confirm = (ids: number[]) =>
    run(async () => {
      await api.post('/transactions/review/confirm', { ids });
      if (ids.length > 1) return `${ids.length} lançamentos conferidos`;
    });

  return (
    <section className="panel review-panel" aria-busy={busy}>
      <div className="panel-head">
        <h2>
          Conferir importados <span className="count-badge">{data.length}</span>
        </h2>
        <button className="link-btn" onClick={() => confirm(data.map((t) => t.id))} disabled={busy}>
          Confirmar todos
        </button>
      </div>
      <p className="muted review-hint">Vieram do banco com a categoria escolhida pelo app. Troque a que estiver errada: o app aprende para as próximas.</p>
      <ul className="review-list">
        {visible.map((t) => (
          <li key={t.id}>
            <span className="review-main">
              <span className="tx-desc">{t.description || t.categoryName}</span>
              <span className="tx-cat">
                {dayLabel(t.date)}
                {t.source && <span className="bank-tag">{t.source}</span>}
              </span>
            </span>
            <span className={`tx-value tnum ${t.kind}`}>
              {t.kind === 'entrada' ? '+' : '−'} {money(t.amountCents)}
            </span>
            <select
              className="review-select"
              aria-label={`Categoria de ${t.description || 'lançamento'}`}
              value={t.categoryId}
              disabled={busy}
              onChange={(e) => change(t, Number(e.target.value))}
            >
              {categories
                .filter((c) => c.kind === t.kind && (!c.archived || c.id === t.categoryId))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <button className="icon-btn review-ok" aria-label={`Confirmar ${t.description || 'lançamento'}`} disabled={busy} onClick={() => confirm([t.id])}>
              <IconCheck width={20} height={20} />
            </button>
          </li>
        ))}
      </ul>
      {data.length > PREVIEW && !showAll && (
        <button className="link-btn" onClick={() => setShowAll(true)}>
          Ver todos os {data.length}
        </button>
      )}
    </section>
  );
}
