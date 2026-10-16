import { parseMoneyToCents } from './money.js';

/** Parser de CSV com aspas, quebra de linha dentro de campo e detecção de separador. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', '\t', ','].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best
  , ',');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim();

export function parseDate(raw: string, fallbackYear?: number): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? +m[3] : fallbackYear;
    if (!year) return null;
    if (year < 100) year += 2000;
    return valid(year, +m[2], +m[1]);
  }
  return null;
}

function valid(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface ParsedRow {
  line: number;
  date: string;
  category: string;
  description: string;
  kind: 'entrada' | 'saida';
  amountCents: number;
}

export interface RowError {
  line: number;
  message: string;
}

/**
 * Lê o CSV de uma aba da planilha (Data, Categoria, Descrição, Entrada, Saída)
 * ou de um extrato simples (Data, Descrição, Valor com sinal).
 */
export function parseTransactionsCsv(text: string, opts: { fallbackYear?: number } = {}) {
  const table = parseCsv(text);
  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];

  const headerIndex = table.findIndex((r) => {
    const cells = r.map(normalize);
    return cells.includes('data') && (cells.includes('valor') || cells.includes('entrada') || cells.includes('saida'));
  });
  if (headerIndex < 0) {
    errors.push({ line: 1, message: 'Não achei o cabeçalho. A planilha precisa das colunas Data e Entrada/Saída (ou Valor).' });
    return { rows, errors };
  }

  const header = table[headerIndex].map(normalize);
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const cDate = col('data');
  const cCat = col('categoria');
  const cDesc = col('descricao', 'historico', 'lancamento');
  const cIn = col('entrada', 'entradas', 'receita');
  const cOut = col('saida', 'saidas', 'despesa');
  const cValue = col('valor');

  for (let i = headerIndex + 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    const get = (c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');
    if (r.every((cell) => cell.trim() === '')) continue;

    const rawDate = get(cDate);
    if (!rawDate) continue; // linhas de total/rodapé da planilha
    const date = parseDate(rawDate, opts.fallbackYear);
    if (!date) {
      errors.push({ line, message: `Data inválida: "${rawDate}"` });
      continue;
    }

    let kind: 'entrada' | 'saida';
    let amount: number | null;
    if (cIn >= 0 || cOut >= 0) {
      const inc = parseMoneyToCents(get(cIn));
      const out = parseMoneyToCents(get(cOut));
      if (inc === null || out === null) {
        errors.push({ line, message: 'Valor que não é número na Entrada ou Saída' });
        continue;
      }
      if (inc && out) {
        errors.push({ line, message: 'A linha tem Entrada e Saída preenchidas ao mesmo tempo' });
        continue;
      }
      kind = inc ? 'entrada' : 'saida';
      amount = Math.abs(inc || out);
    } else {
      const v = parseMoneyToCents(get(cValue));
      if (v === null) {
        errors.push({ line, message: `Valor inválido: "${get(cValue)}"` });
        continue;
      }
      kind = v >= 0 ? 'entrada' : 'saida';
      amount = Math.abs(v);
    }
    if (!amount) continue; // linha zerada

    const category = get(cCat) || (kind === 'entrada' ? 'Outras receitas' : 'Imprevistos/Outros');
    rows.push({ line, date, category, description: get(cDesc), kind, amountCents: amount });
  }
  return { rows, errors };
}

export function toCsv(rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}
