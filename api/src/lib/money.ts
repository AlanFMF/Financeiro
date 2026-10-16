/**
 * Converte texto de valor em centavos. Aceita os formatos que aparecem em planilhas
 * e extratos brasileiros: "1227.76", "1.227,76", "R$ 150,00", "-", "".
 * Retorna 0 para vazio/traço e null quando não dá para entender.
 */
export function parseMoneyToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;

  let s = input.trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (s === '' || s === '-' || s === '—') return 0;

  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // O separador que vem por último é o decimal.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.500" ou "12.300.000": ponto como milhar.
    s = s.replace(/\./g, '');
  }

  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return negative ? -cents : cents;
}

/** Mês no formato AAAA-MM. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Avança a parcela de uma descrição "Financiamento (10/48)" → "Financiamento (11/48)".
 * Retorna null quando a última parcela já foi lançada (nada a copiar).
 * Descrições sem parcela voltam iguais.
 */
export function nextInstallment(description: string): string | null {
  const match = description.match(/\((\d{1,3})\s*\/\s*(\d{1,3})\)/);
  if (!match) return description;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (current >= total) return null;
  return description.replace(match[0], `(${current + 1}/${total})`);
}
