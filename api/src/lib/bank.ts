import { categoryFromHistory, keywordCategory, type HistoryHint } from '../assistant/rules.js';

type Kind = 'entrada' | 'saida';

const flat = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Categorias do agregador de Open Finance (em inglês) para as do Saldo.
 * "Fortes" são específicas o bastante para vencer as palavras-chave; "fracas" só valem se nada melhor bater.
 */
const STRONG: [RegExp, string][] = [
  [/grocer|supermarket|eating out|restaurant|food|bakery/, 'Alimentação'],
  [/electric|water|rent\b|housing|utilit|condominium/, 'Moradia'],
  [/telecom|internet|mobile|phone/, 'Contas'],
  [/taxi|ride.?hailing|gas station|fuel|parking|public transport|toll|vehicle|automotive/, 'Transporte'],
  [/pharma|drugstore|health|hospital|dentist|optic|medical/, 'Saúde'],
  [/\bpet/, 'Pet'],
  [/digital service|streaming|subscription|software/, 'Assinaturas'],
  [/educat|course|bookstore|school/, 'Educação'],
  [/leisure|entertain|travel|accommodation|airline|airport|lodging|culture|sport|gaming/, 'Lazer'],
  [/beauty|wellness|gym|fitness|personal care|hairdress/, 'Cuidados pessoais'],
  [/clothing|electronics|department store/, 'Compras'],
  [/invest|saving/, 'Investimentos'],
  [/salary|payroll|wage/, 'Pró-labore/Salário']
];
const WEAK: [RegExp, string][] = [[/shopping|online/, 'Compras']];

const INCOME = new Set(['Pró-labore/Salário', 'Extra', 'Outras receitas']);

function fromBank(bankCategory: string | undefined, kind: Kind, table: [RegExp, string][]) {
  if (!bankCategory) return null;
  const c = bankCategory.toLowerCase();
  for (const [re, cat] of table) if (re.test(c) && INCOME.has(cat) === (kind === 'entrada')) return cat;
  return null;
}

/**
 * Escolhe a categoria de um lançamento vindo do banco, nesta ordem:
 * 1. o hábito do usuário (como ele já categorizou essa descrição);
 * 2. a categoria do banco, quando é específica (Supermercado, Energia, Streaming);
 * 3. palavras-chave na descrição;
 * 4. a categoria do banco genérica (Compras);
 * 5. Outras receitas / Imprevistos.
 */
export function categorizeBank(description: string, kind: Kind, bankCategory: string | undefined, habits: HistoryHint[]) {
  const hint = categoryFromHistory(description, kind, habits);
  if (hint && hint.kind === kind) return hint.category;
  return (
    fromBank(bankCategory, kind, STRONG) ??
    keywordCategory(flat(description), kind) ??
    fromBank(bankCategory, kind, WEAK) ??
    (kind === 'entrada' ? 'Outras receitas' : 'Imprevistos/Outros')
  );
}

const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o']);

/** "CEMIG DISTRIBUICAO S.A" → "Cemig Distribuicao S.A"; textos já em caixa mista ficam como estão. */
function tidyCase(s: string) {
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      if (/^([a-z]\.)+[a-z]?\.?$/.test(w)) return w.toUpperCase(); // S.A, S/A
      return i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/**
 * Deixa a descrição do extrato legível e no padrão do app:
 *   "Transferência Recebida|Fulano"            → "Pix de Fulano"
 *   "Transferência enviada pelo Pix|CEMIG S.A" → "Pix para Cemig S.A"
 *   "Pagamento efetuado|IMOBILIARIA LTDA"      → "Pagamento a Imobiliaria Ltda"
 *   "Compra no débito|PADARIA"                 → "Padaria"
 *   "Shopee *Loja 5/6"                         → "Shopee *Loja (5/6)"
 */
export function cleanBankDescription(raw: string, installment?: { number: number; total: number }) {
  let d = raw.replace(/\s+/g, ' ').trim();
  const [head, ...rest] = d.split('|').map((p) => p.trim());
  // Microempreendedor aparece com o CNPJ na frente ("64.099.660 SILAS MARTI"): o número não ajuda ninguém.
  const tail = tidyCase(rest.join(' ').replace(/^\d{2}\.?\d{3}\.?\d{3}(\/?\d{4}-?\d{2})?\s+/, '').trim());
  const h = flat(head);
  if (tail) {
    if (/transferencia recebida|pix recebido/.test(h)) d = `Pix de ${tail}`;
    else if (/transferencia enviada|pix enviado/.test(h)) d = `Pix para ${tail}`;
    else if (/pagamento efetuado|pagamento de boleto/.test(h)) d = `Pagamento a ${tail}`;
    else if (/compra no debito|compra no credito/.test(h)) d = tail;
    else d = `${head} ${tail}`;
  } else {
    d = head.charAt(0) + head.slice(1).toLowerCase() === head ? head : tidyCase(head);
  }

  // Parcela: usa a do banco, ou a que vier no fim do texto ("Loja 5/6").
  const m = d.match(/\s(\d{1,2})\/(\d{1,2})$/);
  const inst = installment ?? (m ? { number: Number(m[1]), total: Number(m[2]) } : undefined);
  if (m) d = d.slice(0, m.index).trim();
  if (inst && inst.total > 1) d = `${d} (${inst.number}/${inst.total})`;
  return d.slice(0, 120);
}

/** Pagamento da fatura do cartão: já está contado nas compras, não pode entrar de novo. */
export function isCardBillPayment(description: string, bankCategory?: string) {
  const d = flat(`${description} ${bankCategory ?? ''}`);
  return /pagamento (de |da )?fatura|pagamento recebido|credit card payment/.test(d);
}
