import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type ImportResult } from '../api';
import { dayLabel, money } from '../format';
import { useInvalidate } from '../queries';
import { useEditor } from '../components/Layout';

export function ImportPage() {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const { toast } = useEditor();
  const invalidate = useInvalidate();
  const year = new Date().getFullYear();

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<ImportResult>('/import/csv', { csv, dryRun, year }),
    onSuccess: async (r) => {
      if (r.dryRun) return setPreview(r);
      await invalidate();
      setPreview(null);
      setCsv('');
      setFileName(null);
      toast(
        r.duplicates
          ? `${r.created} importados, ${r.duplicates} já existiam`
          : `${r.created} lançamento${r.created === 1 ? '' : 's'} importado${r.created === 1 ? '' : 's'}`
      );
    }
  });

  async function onFile(file?: File) {
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setCsv(await file.text());
  }

  return (
    <div className="page narrow">
      <h1 className="page-title">Importar da planilha</h1>
      <p className="lead">
        Traga os meses que você já tem no Google Sheets. No Sheets, abra a aba do mês e use{' '}
        <strong>Arquivo, Fazer download, Valores separados por vírgula (.csv)</strong>. O arquivo precisa ter as colunas Data,
        Categoria, Descrição, Entrada e Saída. Extratos com uma coluna Valor também funcionam.
      </p>

      <section className="panel">
        <label className="dropzone" data-filled={Boolean(fileName)}>
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
          <strong>{fileName ?? 'Escolher arquivo CSV'}</strong>
          <span>{fileName ? 'Toque para trocar de arquivo' : 'ou cole o conteúdo abaixo'}</span>
        </label>

        <label className="field">
          <span>Conteúdo do CSV</span>
          <textarea
            rows={5}
            value={csv}
            placeholder={'Data,Categoria,Descrição,Entrada (R$),Saída (R$)\n10/10/2026,Moradia,Condomínio,,150.00'}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
            }}
          />
        </label>

        {run.isError && (
          <p className="form-error" role="alert">
            {(run.error as Error).message}
          </p>
        )}

        <button className="btn primary" disabled={!csv.trim() || run.isPending} onClick={() => run.mutate(true)}>
          {run.isPending && !preview ? 'Lendo…' : 'Ver prévia'}
        </button>
      </section>

      {preview && (
        <section className="panel preview">
          <div className="panel-head">
            <h2>
              {preview.rows.length} lançamento{preview.rows.length === 1 ? '' : 's'} encontrado{preview.rows.length === 1 ? '' : 's'}
            </h2>
          </div>
          <dl className="hero-figures compact">
            <div>
              <dt>Entradas</dt>
              <dd className="tnum">{money(preview.totals.income)}</dd>
            </div>
            <div>
              <dt>Saídas</dt>
              <dd className="tnum">{money(preview.totals.expense)}</dd>
            </div>
          </dl>

          {preview.newCategories.length > 0 && (
            <p className="note">
              Categorias novas que serão criadas: {preview.newCategories.map((c) => c.name).join(', ')}.
            </p>
          )}
          {preview.errors.length > 0 && (
            <div className="note warn">
              <p>
                {preview.errors.length} linha{preview.errors.length > 1 ? 's' : ''} {preview.errors.length > 1 ? 'ficarão' : 'ficará'} de fora:
              </p>
              <ul>
                {preview.errors.slice(0, 8).map((e) => (
                  <li key={e.line}>
                    Linha {e.line}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.rows.length > 0 && (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Categoria</th>
                      <th>Descrição</th>
                      <th className="num">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 60).map((r) => (
                      <tr key={r.line}>
                        <td>{dayLabel(r.date)}</td>
                        <td>{r.category}</td>
                        <td>{r.description}</td>
                        <td className={`num tnum ${r.kind}`}>
                          {r.kind === 'entrada' ? '+' : '−'} {money(r.amountCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > 60 && <p className="muted">Mostrando 60 de {preview.rows.length}.</p>}
              <p className="muted">Lançamentos idênticos aos que você já tem são pulados, então pode importar o mesmo mês de novo.</p>
              <button className="btn primary" disabled={run.isPending} onClick={() => run.mutate(false)}>
                {run.isPending ? 'Importando…' : `Importar ${preview.rows.length} lançamento${preview.rows.length === 1 ? '' : 's'}`}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
