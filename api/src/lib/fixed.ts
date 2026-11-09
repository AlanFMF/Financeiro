/**
 * Reconhece o pagamento de uma conta fixa (aluguel, internet, assinatura) vindo do banco,
 * mesmo em outro dia do mês, com descrição diferente ou valor um pouco diferente:
 * - mesmo valor no mesmo mês: é o mesmo pagamento;
 * - valor até 15% diferente e um nome em comum ("Netflix" e "Netflix.Com", "YouTube Premium" e
 *   "Google Youtubepremium", "Meli+" e "Mp *Melimais"): também é;
 * - valor até 15% diferente na mesma categoria de conta (o boleto da imobiliária e o "Aluguel"): também é.
 */

const NOISE = new Set([
  'pix', 'para', 'pelo', 'pela', 'transferencia', 'enviada', 'recebida', 'compra', 'debito', 'credito', 'pagamento', 'pagto',
  'com', 'www', 'ltda', 'eireli', 'servicos', 'brasil', 'google', 'mp', 'pg', 'pagseguro', 'ebanx', 'dlocal'
]);

const flat = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Palavras que identificam o serviço (sem "pix", "transferência", nomes de intermediador de pagamento etc.). */
export function nameTokens(description: string): string[] {
  return flat(description)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NOISE.has(w) && !/^\d+$/.test(w));
}

export function sameName(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.some((w) => tb.includes(w))) return true;
  // Nomes grudados ou abreviados: "youtubepremium" começa com "youtube"; "melimais" começa com "meli".
  // Só no começo da palavra: "supermercado" não é o "Mercado" fixo.
  const prefix = (xs: string[], ys: string[]) => xs.some((w) => w.length >= 4 && ys.some((y) => y.startsWith(w)));
  return prefix(ta, tb) || prefix(tb, ta);
}

export interface FixedCandidate {
  id: number;
  description: string;
  amountCents: number;
  /** Nome da categoria do fixo. */
  category?: string;
}

/**
 * Categorias de contas de valor previsível (aluguel, condomínio, internet, assinatura, mensalidade).
 * Nelas, mesma categoria e valor próximo bastam: o boleto da imobiliária não tem o nome "aluguel" e o valor
 * muda um pouco todo mês. Mercado, combustível e afins ficam de fora: lá, valor parecido é coincidência.
 */
const BILL_CATEGORIES = new Set(['Moradia', 'Contas', 'Assinaturas', 'Educação']);
const TOLERANCE = 0.15;

/**
 * Nota da semelhança (0 = não é o mesmo pagamento):
 * 3 = mesmo valor e mesmo nome; 2 = mesmo valor; 1 = valor até 15% diferente e mesmo nome, ou mesma categoria de conta.
 */
export function fixedScore(
  fixed: { description: string; amountCents: number; category?: string },
  bank: { description: string; amountCents: number; category?: string }
): number {
  const name = sameName(fixed.description, bank.description);
  if (fixed.amountCents === bank.amountCents) return name ? 3 : 2;
  const diff = Math.abs(fixed.amountCents - bank.amountCents) / Math.max(fixed.amountCents, 1);
  if (diff > TOLERANCE) return 0;
  const bill = Boolean(fixed.category && fixed.category === bank.category && BILL_CATEGORIES.has(fixed.category));
  return name || bill ? 1 : 0;
}

/** O candidato mais parecido (ou nenhum). Em empate, o de valor mais próximo; depois, o primeiro da lista. */
export function bestFixedMatch<T extends FixedCandidate>(
  candidates: T[],
  bank: { description: string; amountCents: number; category?: string }
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  let bestDiff = Infinity;
  for (const c of candidates) {
    const s = fixedScore(c, bank);
    const diff = Math.abs(c.amountCents - bank.amountCents);
    if (s > bestScore || (s > 0 && s === bestScore && diff < bestDiff)) {
      best = c;
      bestScore = s;
      bestDiff = diff;
    }
  }
  return best;
}
