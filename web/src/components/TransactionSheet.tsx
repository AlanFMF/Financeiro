import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type Kind, type Transaction } from '../api';
import { centsToInput, currentMonth, parseAmount, todayIso } from '../format';
import { useCategories, useDeleteTransaction, useMonth, useSaveTransaction } from '../queries';
import { IconClose } from './Icons';
import { useBackHandler } from '../backButton';

interface Props {
  transaction: Transaction | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function TransactionSheet({ transaction, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [month] = useMonth();
  const { data: categories = [] } = useCategories();
  const save = useSaveTransaction();
  const remove = useDeleteTransaction();

  const [kind, setKind] = useState<Kind>(transaction?.kind ?? 'saida');
  const [amount, setAmount] = useState(transaction ? centsToInput(transaction.amountCents) : '');
  const [categoryId, setCategoryId] = useState<number | null>(transaction?.categoryId ?? null);
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [date, setDate] = useState(transaction?.date ?? (month === currentMonth() ? todayIso() : `${month}-01`));
  const [isFixed, setIsFixed] = useState(transaction?.isFixed ?? false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Voltar do Android fecha o formulário, como o X.
  useBackHandler(true, () => dialog.current?.close());

  const options = categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryId));
  const selected = options.find((c) => c.id === categoryId);

  const switchKind = (k: Kind) => {
    setKind(k);
    if (categories.find((c) => c.id === categoryId)?.kind !== k) setCategoryId(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmount(amount);
    if (!cents) return setError('Digite um valor maior que zero, por exemplo 45,90.');
    if (!categoryId) return setError('Escolha uma categoria.');
    setError(null);
    try {
      const r = await save.mutateAsync({ id: transaction?.id, categoryId, date, description: description.trim(), amountCents: cents, isFixed });
      const done = transaction ? 'Lançamento atualizado' : kind === 'saida' ? 'Saída lançada' : 'Entrada lançada';
      onSaved(r.queued ? `${done} no aparelho. Sobe quando a internet voltar.` : done);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    }
  }

  async function doDelete() {
    if (!transaction) return;
    try {
      const r = await remove.mutateAsync(transaction.id);
      onSaved(r.queued ? 'Excluído no aparelho. Sobe quando a internet voltar.' : 'Lançamento excluído');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby="sheet-title"
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && dialog.current?.close()}
    >
      <form onSubmit={submit} className="sheet-body" noValidate>
        <header className="sheet-head">
          <h2 id="sheet-title">{transaction ? 'Editar lançamento' : 'Novo lançamento'}</h2>
          <button type="button" className="icon-btn" aria-label="Fechar" onClick={() => dialog.current?.close()}>
            <IconClose />
          </button>
        </header>

        <div className="segmented" role="radiogroup" aria-label="Tipo">
          {(['saida', 'entrada'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={`seg ${k}`}
              onClick={() => switchKind(k)}
            >
              {k === 'saida' ? 'Saída' : 'Entrada'}
            </button>
          ))}
        </div>

        <label className="amount-field" data-kind={kind}>
          <span className="sr-only">Valor</span>
          <span className="currency" aria-hidden="true">R$</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
            autoFocus={!transaction}
          />
        </label>

        <fieldset className="field">
          <legend>Categoria{selected ? `: ${selected.name}` : ''}</legend>
          <div className="chips">
            {options.map((c) => (
              <button
                key={c.id}
                type="button"
                className="chip"
                aria-pressed={c.id === categoryId}
                style={{ '--chip': c.color } as React.CSSProperties}
                onClick={() => setCategoryId(c.id)}
              >
                <i aria-hidden="true" />
                {c.name}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="row-2">
          <label className="field">
            <span>Descrição</span>
            <input value={description} maxLength={120} placeholder="Ex.: Mercado do mês" onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field date">
            <span>Data</span>
            <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>

        <label className="toggle">
          <input type="checkbox" checked={isFixed} onChange={(e) => setIsFixed(e.target.checked)} />
          <span>
            <strong>Repete todo mês</strong>
            <small>Entra em "Copiar fixos" do mês seguinte. Parcelas como (10/48) avançam sozinhas.</small>
          </span>
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <footer className="sheet-actions">
          {transaction &&
            (confirmDelete ? (
              <button type="button" className="btn danger" onClick={doDelete} disabled={remove.isPending}>
                Confirmar exclusão
              </button>
            ) : (
              <button type="button" className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>
                Excluir
              </button>
            ))}
          <button type="submit" className="btn primary grow" disabled={save.isPending}>
            {save.isPending ? 'Salvando…' : transaction ? 'Salvar alterações' : kind === 'saida' ? 'Lançar saída' : 'Lançar entrada'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
