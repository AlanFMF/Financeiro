import { parseMoneyToCents } from '../lib/money.js';

/**
 * Modo simples: interpretador por regras, usado quando não há chave da API da Claude.
 *
 * Entende, por exemplo:
 *   "gastei 45,90 no mercado e 120 de gasolina ontem"
 *   "paguei cinquenta reais e noventa centavos de luz na sexta passada"
 *   "comprei um tênis de 600 em 6x no cartão"
 *   "caiu o salário, 4.850"   "uber 32"   "dia 10 paguei 1,2 mil de aluguel"
 * e aprende com o histórico: se você já lançou "Ração" em Pet, a próxima "ração" vai para Pet.
 */

export interface RuleItem {
  kind: 'entrada' | 'saida';
  category: string;
  amountCents: number;
  date: string;
  description: string;
  isFixed: boolean;
}

/** Como o usuário já categorizou cada descrição, da mais frequente para a menos. */
export interface HistoryHint {
  description: string;
  category: string;
  kind: 'entrada' | 'saida';
}

type Kind = 'entrada' | 'saida';

/**
 * Minúsculas e sem acento, preservando o comprimento do texto (em NFC cada letra acentuada vira uma letra).
 * Assim um trecho achado na versão sem acento pode ser recortado da versão original pelos mesmos índices.
 */
const flat = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Apaga (troca por espaços) o que casar com `re` na versão sem acento, mantendo o resto do original. */
function blankOut(text: string, re: RegExp) {
  const f = flat(text);
  if (f.length !== text.length) return text;
  let out = text;
  for (const m of f.matchAll(new RegExp(re.source, 'g'))) {
    out = out.slice(0, m.index) + ' '.repeat(m[0].length) + out.slice(m.index! + m[0].length);
  }
  return out;
}

// ---------------------------------------------------------------- vocabulário

const OUT_VERBS =
  /\b(gastei|gasto|paguei|pago|comprei|compro|saiu|sairam|torrei|debitou|debitaram|transferi|mandei|abasteci|almocei|jantei|pedi|assinei|renovei|investi|apliquei|guardei|doei|emprestei|perdi)\b/;
const IN_VERBS = /\b(recebi|recebo|ganhei|entrou|entraram|caiu|cairam|vendi|depositaram|pagaram|devolveram|reembolsaram|rendeu)\b/;
/** Verbos que só servem para achar onde começa a descrição ("passei no drive-thru"). */
const OTHER_VERBS = /\b(passei|fui|fiz|tomei|peguei|levei|botei|coloquei|usei|dei)\b/;
const INCOME_WORDS =
  /\b(salario|pro-?labore|holerite|freela|freelance|reembolso|pix recebido|cliente|rendimento|dividendos?|13o|decimo terceiro|bonus|comissao)\b/;

/** Palavra-chave → categoria padrão. A primeira que bater vence. */
const KEYWORDS: [RegExp, string][] = [
  [/salario|pro-?labore|holerite|13o|decimo terceiro/, 'Pró-labore/Salário'],
  [/freela|freelance|bico|extra|venda|vendi|comissao|bonus|cliente/, 'Extra'],
  [/aluguel|condominio|\bluz\b|energia|\bagua\b|\bgas\b|iptu|cemig|reforma|\bmove(l|is)\b/, 'Moradia'],
  [/internet|celular|telefone|plano de dados|recarga|\bvivo\b|\bclaro\b|\btim\b|\boi\b|algar/, 'Contas'],
  [
    /mercado|supermercado|padaria|feira|restaurante|lanche|ifood|\bifd\b|almoc|almoco|janta|\bcafes?\b|pizza|acougue|hortifruti|sorvete|hamburguer|marmita|delivery|drive|acai|refri|cerveja|\bpao\b/,
    'Alimentação'
  ],
  [
    /gasolina|combustivel|etanol|alcool|diesel|abasteci|posto|\buber\b|\b99\b|\bhinova\b|itucar|protecao veicular|taxi|onibus|metro|estacionamento|pedagio|ipva|licenciamento|seguro do carro|seguro carro|oficina|mecanico|pneu|financiamento|lava.?jato|multa/,
    'Transporte'
  ],
  [/farmacia|remedio|medico|dentista|exame|consulta|plano de saude|hospital|psicolog|terapia|otica|oculos/, 'Saúde'],
  [/racao|veterinari|\bpet\b|banho e tosa|petshop|areia do gato/, 'Pet'],
  [
    /netflix|spotify|youtube|prime|hbo|\bmax\b|disney|globoplay|assinatura|google one|icloud|claude|chatgpt|meli\+|deezer/,
    'Assinaturas'
  ],
  [/curso|faculdade|pos-?graduacao|\bpos\b|livro|escola|mensalidade|material escolar|apostila|udemy|alura/, 'Educação'],
  [/cinema|show|\bbar\b|viagem|passeio|\bjogo\b|steam|playstation|xbox|balada|ingresso|hotel|airbnb|festa/, 'Lazer'],
  [/barbearia|barbeiro|cabelo|salao|manicure|perfume|academia|cosmetic|maquiagem|\bunha/, 'Cuidados pessoais'],
  [/roupa|tenis|sapato|loja|shopping|presente|amazon|mercado livre|shopee|magalu|\btv\b|televisao|notebook|geladeira|\bfone\b/, 'Compras'],
  [/investi|aplicacao|apliquei|tesouro|\bcdb\b|acoes|reserva|poupanca|guardei|cripto|bitcoin/, 'Investimentos']
];

const INCOME_CATEGORIES = new Set(['Pró-labore/Salário', 'Extra', 'Outras receitas']);

/** Forma de pagamento não é categoria: "no cartão", "via pix". */
const PAYMENT_METHODS =
  /\b(no|na|pelo|pela|via|com|em)\s+(cartao( de credito| de debito)?|credito|debito|pix|dinheiro|boleto|nubank|vale refeicao|vale alimentacao|vr|va)\b/;

/** Expressões de data, para tirar da descrição. */
const DATE_TEXT =
  /\b(anteontem|ontem|hoje|(n[oa]\s+)?(domingo|segunda(-feira)?|terca(-feira)?|quarta(-feira)?|quinta(-feira)?|sexta(-feira)?|sabado)(\s+(passad[oa]|retrasad[oa]))?|(no\s+)?(dia\s+)?\d{1,2}\/\d{1,2}(\/\d{2,4})?|(no\s+)?dia\s+\d{1,2}(\s+do\s+mes\s+passado)?|(no\s+)?mes\s+passado|todo mes|todos os meses|mensalmente|por mes)\b/;

const FILLER = new Set([
  'eu', 'hoje', 'agora', 'so', 'tambem', 'mais', 'um', 'uma', 'uns', 'umas', 'o', 'a', 'os', 'as', 'meu', 'minha',
  'meus', 'minhas', 'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'com', 'em', 'pro', 'pra', 'para',
  'pelo', 'pela', 'que', 'foi', 'deu', 'ficou', 'custou', 'total', 'valor', 'reais', 'real', 'conto', 'contos',
  'pila', 'pilas', 'r$', 'e', 'ja', 'ai', 'la', 'aqui', 'isso', 'esse', 'essa', 'cerca', 'quase', 'tipo', 'ate', 'me'
]);

const PREPOSITIONS = new Set(['no', 'na', 'nos', 'nas', 'de', 'do', 'da', 'dos', 'das', 'com', 'em', 'pro', 'pra', 'para', 'pelo', 'pela']);

// ---------------------------------------------------------------- números por extenso

const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18,
  dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80,
  noventa: 90, cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300,
  quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600,
  setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900
};
const CURRENCY_WORD = /^(reais|real|conto|contos|pila|pilas|centavo|centavos)$/;
/** Depois de um número por extenso, estas palavras indicam que é valor ("cinquenta de luz"), não quantidade ("duas pizzas"). */
const AFTER_VALUE = new Set([...PREPOSITIONS, 'e', 'ontem', 'hoje', 'anteontem', 'dia', '']);

const fmtNumber = (cents: number) =>
  cents % 100 === 0 ? String(cents / 100) : `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;

/** "mil e duzentos reais" → "1200 reais"; "cinquenta reais e noventa centavos" → "50,90 reais"; "2k" → "2000". */
export function normalizeAmounts(input: string): string {
  const tokens = input.split(' ');
  const out: string[] = [];
  const hasDigits = /\d/.test(input);
  const core = (t = '') => flat(t).replace(/[.,;!?:]+$/, '');
  const isNum = (t?: string) => t !== undefined && (core(t) in NUMBER_WORDS || core(t) === 'mil');

  for (let i = 0; i < tokens.length; i++) {
    // "1,2 mil" já tem o número em algarismos: deixa o "mil" para a etapa seguinte.
    if (!isNum(tokens[i]) || (core(tokens[i]) === 'mil' && /\d$/.test(tokens[i - 1] ?? ''))) {
      out.push(tokens[i]);
      continue;
    }
    let j = i;
    let total = 0;
    let current = 0;
    let trailing = '';
    while (j < tokens.length && isNum(tokens[j])) {
      const c = core(tokens[j]);
      if (c === 'mil') {
        total += (current || 1) * 1000;
        current = 0;
      } else current += NUMBER_WORDS[c];
      trailing = tokens[j].slice(c.length);
      j++;
      if (trailing) break; // vírgula ou ponto encerra o número
      if (core(tokens[j]) === 'e' && isNum(tokens[j + 1])) j++;
    }
    const run = tokens.slice(i, j);
    const next = trailing ? '' : core(tokens[j]);
    const loneArticle = run.length === 1 && ['um', 'uma'].includes(core(run[0]));
    const convert =
      CURRENCY_WORD.test(next) ||
      core(tokens[i - 1]) === 'r$' ||
      run.some((t) => core(t) === 'mil') ||
      (!loneArticle && !hasDigits && AFTER_VALUE.has(next));
    if (convert) out.push(String(total + current) + trailing);
    else out.push(...run);
    i = j - 1;
  }

  return (
    out
      .join(' ')
      // "2 mil", "1,5 mil", "2k"
      .replace(/(\d+(?:[.,]\d+)?)\s*(?:mil|k)\b/g, (_, n: string) => fmtNumber((parseMoneyToCents(n.replace('.', ',')) ?? 0) * 1000))
      // "45 reais e 90 (centavos)" e "45 e 90 centavos"
      .replace(/(\d+)\s*(reais|real|conto|contos|pila|pilas)\s+e\s+(\d{1,2})(?:\s*centavos?)?\b/g, (_, r, w, c) => `${r},${c.padStart(2, '0')} ${w}`)
      .replace(/(\d+)\s+e\s+(\d{1,2})\s*centavos?\b/g, (_, r, c) => `${r},${c.padStart(2, '0')}`)
      .replace(/(?<![\d,])(\d{1,2})\s*centavos?\b/g, (_, c) => `0,${c.padStart(2, '0')}`)
  );
}

// ---------------------------------------------------------------- datas

const WEEKDAYS: [RegExp, number][] = [
  [/\bdomingo\b/, 0],
  [/\bsegunda(-feira)?\b/, 1],
  [/\bterca(-feira)?\b/, 2],
  [/\bquarta(-feira)?\b/, 3],
  [/\bquinta(-feira)?\b/, 4],
  [/\bsexta(-feira)?\b/, 5],
  [/\bsabado\b/, 6]
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const noon = (day: string) => new Date(`${day}T12:00:00Z`);
function addDays(day: string, days: number) {
  const d = noon(day);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
function validDate(y: number, m: number, d: number) {
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? iso(date) : null;
}

/** Data dita no texto (já sem acento), ou null se não houver. Datas sem ano nunca caem no futuro. */
export function findDate(text: string, today: string): string | null {
  if (/\banteontem\b/.test(text)) return addDays(today, -2);
  if (/\bontem\b/.test(text)) return addDays(today, -1);
  if (/\bhoje\b/.test(text)) return today;

  const [ty, tm, td] = today.split('-').map(Number);

  let m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    let y = m[3] ? Number(m[3]) : ty;
    if (y < 100) y += 2000;
    const d = validDate(y, Number(m[2]), Number(m[1]));
    if (d && !m[3] && d > today) return validDate(y - 1, Number(m[2]), Number(m[1]));
    if (d) return d;
  }

  m = text.match(/\bdia (\d{1,2})(\s+do\s+mes\s+passado)?\b/);
  if (m) {
    const day = Number(m[1]);
    const lastMonth = Boolean(m[2]) || day > td;
    const ref = new Date(Date.UTC(ty, tm - 1 - (lastMonth ? 1 : 0), 1, 12));
    const d = validDate(ref.getUTCFullYear(), ref.getUTCMonth() + 1, day);
    if (d) return d;
  }

  for (const [re, wd] of WEEKDAYS) {
    if (!re.test(text)) continue;
    let back = (noon(today).getUTCDay() - wd + 7) % 7;
    if (/\b(passad[oa]|retrasad[oa])\b/.test(text) && back === 0) back = 7;
    if (/\bretrasad[oa]\b/.test(text)) back += 7;
    return addDays(today, -back);
  }
  return null;
}

// ---------------------------------------------------------------- parcelas e valor

interface Installment {
  current: number;
  total: number;
  /** true quando o valor citado é o total da compra e precisa ser dividido pelas parcelas. */
  divide: boolean;
}

function extractInstallment(text: string): { text: string; inst: Installment | null } {
  const f = flat(text);
  const cut = (m: RegExpMatchArray, replacement = ' ') => text.slice(0, m.index) + replacement + text.slice(m.index! + m[0].length);

  // "parcela 3/10", "parcela 3 de 10", "(3/10)"
  let m = f.match(/\bparcela\s*(\d{1,3})\s*(?:\/|de)\s*(\d{1,3})\b|\((\d{1,3})\/(\d{1,3})\)/);
  if (m) {
    const current = Number(m[1] ?? m[3]);
    const total = Number(m[2] ?? m[4]);
    if (current >= 1 && current <= total) return { text: cut(m), inst: { current, total, divide: false } };
  }
  // "10x de 89,90", "em 10 vezes de 150", "6 parcelas de 100": o valor é de cada parcela
  m = f.match(/\b(?:em\s+)?(\d{1,2})\s*(?:x|vezes|parcelas)\s+(?:sem juros\s+)?de\b/);
  if (m && Number(m[1]) > 1) return { text: cut(m, ' de '), inst: { current: 1, total: Number(m[1]), divide: false } };
  // "1500 em 10x", "parcelei em 12 vezes": o valor é o total
  m = f.match(/\bem\s+(\d{1,2})\s*(?:x|vezes|parcelas)\b(\s+sem juros)?/);
  if (m && Number(m[1]) > 1) return { text: cut(m), inst: { current: 1, total: Number(m[1]), divide: true } };
  return { text, inst: null };
}

const AMOUNT_RE =
  /(r\$\s*)?(?<![\d.,/])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d/])(\s*(?:reais|real|conto|contos|pila|pilas)\b)?/g;
const PLUS_BEFORE = /\b(de|por|foi|deu|custou|paguei|gastei|recebi|ganhei|valor|total|saiu|ficou|pago|comprei|caiu|entrou|abasteci)\s*$/;
const MINUS_BEFORE = /\b(no|na|nos|nas|do|da)\s*$/;

/** Escolhe o valor do item quando há mais de um número ("2 cafés de 10", "15 no 99"). */
function pickAmount(text: string) {
  const f = flat(text);
  let best: { cents: number; index: number; length: number; score: number } | null = null;
  for (const m of f.matchAll(AMOUNT_RE)) {
    const cents = parseMoneyToCents(m[2]);
    if (!cents || cents <= 0) continue;
    const before = f.slice(0, m.index);
    let score = 0;
    if (m[1] || m[3]) score += 3;
    if (/[.,]\d{1,2}$/.test(m[2])) score += 2;
    if (PLUS_BEFORE.test(before)) score += 1;
    if (MINUS_BEFORE.test(before)) score -= 1;
    if (!best || score > best.score || (score === best.score && cents > best.cents)) {
      best = { cents, index: m.index!, length: m[0].length, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------- descrição e categoria

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function trimFiller(words: string[]) {
  const w = [...words];
  while (w.length && FILLER.has(flat(w[0]))) w.shift();
  while (w.length && FILLER.has(flat(w[w.length - 1]))) w.pop();
  return w;
}

const isVerb = (w: string) => OUT_VERBS.test(flat(w)) || IN_VERBS.test(flat(w)) || OTHER_VERBS.test(flat(w));

/** Quando só sobra o verbo ("abasteci 150"), ele mesmo diz o que foi. */
const VERB_DESCRIPTION: Record<string, string> = {
  abasteci: 'Combustível',
  almocei: 'Almoço',
  jantei: 'Jantar',
  investi: 'Investimento',
  apliquei: 'Investimento',
  guardei: 'Reserva'
};

export function extractDescription(rest: string): string {
  const raw = rest.replace(/[,.;!?]+/g, ' ').split(/\s+/).filter(Boolean);
  // Valor tirado do meio deixa preposições seguidas ("pix de do cliente"): fica só a última.
  const words = raw.filter((w, i) => !(PREPOSITIONS.has(flat(w)) && PREPOSITIONS.has(flat(raw[i + 1] ?? ''))));
  const verbIdx = words.findIndex(isVerb);
  let chosen: string[];
  if (verbIdx < 0) {
    // Sem verbo ("uber 32", "ração do thor 89"): a frase inteira é a descrição.
    chosen = trimFiller(words);
  } else {
    const after = words.slice(verbIdx + 1);
    // Com verbo: o primeiro trecho depois de uma preposição ("gastei 45 no mercado", "paguei 300 de luz").
    const p = after.findIndex((w) => PREPOSITIONS.has(flat(w)));
    chosen = p >= 0 ? trimFiller(after.slice(p + 1)) : [];
    if (!chosen.length) chosen = trimFiller(after.filter((w) => !isVerb(w)));
    if (!chosen.length) chosen = trimFiller(words.slice(0, verbIdx));
    if (!chosen.length && VERB_DESCRIPTION[flat(words[verbIdx])]) return VERB_DESCRIPTION[flat(words[verbIdx])];
  }
  return capitalize(chosen.join(' ')).slice(0, 60);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function categoryFromHistory(description: string, kind: Kind | null, history: HistoryHint[]) {
  const d = flat(description).trim();
  if (!d) return null;
  const fits = (h: HistoryHint) => !kind || h.kind === kind;
  const exact = history.find((h) => fits(h) && flat(h.description).trim() === d);
  if (exact) return exact;
  // "ração do thor" bate com "ração"; "mercado" bate com "mercado extra"
  return (
    history.find((h) => {
      const hd = flat(h.description).replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
      if (!fits(h) || hd.length < 4) return false;
      return new RegExp(`\\b${escapeRe(hd)}\\b`).test(d) || (d.length >= 4 && new RegExp(`\\b${escapeRe(d)}\\b`).test(hd));
    }) ?? null
  );
}

/** Categoria pela palavra-chave, ou null se nenhuma bater. */
export function keywordCategory(haystack: string, kind: Kind): string | null {
  for (const [re, cat] of KEYWORDS) {
    if (re.test(haystack) && INCOME_CATEGORIES.has(cat) === (kind === 'entrada')) return cat;
  }
  return null;
}

function categoryFromKeywords(haystack: string, kind: Kind) {
  return keywordCategory(haystack, kind) ?? (kind === 'entrada' ? 'Outras receitas' : 'Imprevistos/Outros');
}

// ---------------------------------------------------------------- frase inteira

/** "apaga o último", "desfaz o último lançamento" */
export function isDeleteLastCommand(message: string) {
  const f = flat(message);
  return (
    /\b(apaga|apague|exclui|exclua|desfaz|desfaca|remove|remova|cancela|cancele|deleta|delete)\b/.test(f) &&
    /\bultim[oa]s?\b/.test(f) &&
    !/\d/.test(f)
  );
}

/**
 * Pergunta sobre metas, sem valor na frase: "quanto ainda posso gastar em mercado?", "quanto falta pra meta de lazer?",
 * "como estão minhas metas?". Devolve a categoria citada (texto livre) ou '' para todas; null se não for pergunta de meta.
 */
export function parseBudgetQuestion(message: string): { category: string } | null {
  const f = flat(message)
    .replace(/[?!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\d/.test(f)) return null;
  const tail = (s: string) =>
    s
      .replace(/^(?:(?:a )?meta|(?:o )?limite|(?:o )?orcamento) (?:de|do|da|em|no|na|com|pra|para)\s+/, '')
      .replace(/^(o|a|os|as|meu|minha|meus|minhas)\s+/, '')
      .replace(/\s+(esse|este|neste|nesse) mes$|\s+(no|do|este|esse) mes$/, '')
      .trim();

  let m = f.match(
    /\bquanto (?:ainda )?(?:eu )?(?:posso|consigo|da para|da pra|tenho para|tenho pra|ainda tenho para|ainda tenho pra) gastar (?:em|no|na|nos|nas|com|de|do|da)\s+(.+)$/
  );
  if (m) return { category: tail(m[1]) };
  m = f.match(
    /\bquanto (?:ainda )?(?:me )?(?:resta|sobra|falta|sobrou|restou)(?: para| pra)?(?: gastar)?(?: (?:a|da|na) meta| (?:o|do|no) limite)? (?:em|no|na|com|de|do|da|para|pra|pro)\s+(.+)$/
  );
  if (m) return { category: tail(m[1]) };
  m = f.match(
    /\bquanto falta (?:para|pra) (?:bater |atingir |estourar )?(?:a meta|o limite|o orcamento)(?: (?:de|do|da|em|no|na|com))?\s+(.+)$/
  );
  if (m) return { category: tail(m[1]) };
  if (
    /\b(como (estao|esta|vao|vai)|ver|mostra|mostre|quais sao|resumo d[ao]s?) (as |a |os |o )?(minhas |minha |meus |meu )?(metas?|limites?|orcamentos?)\b/.test(
      f
    )
  )
    return { category: '' };
  if (/^(minhas |as )?metas?$/.test(f)) return { category: '' };
  return null;
}

export function parseByRules(message: string, today: string, history: HistoryHint[] = []): RuleItem[] {
  const base = normalizeAmounts(message.normalize('NFC').toLowerCase().replace(/[ \t]+/g, ' ').trim());
  const fixedAll = /\b(todo mes|todos os meses|mensalmente|por mes)\b/.test(flat(base));

  // Divide em itens: ";", quebra de linha, vírgula fora de número, e "e"/"mais"/"+" quando ainda vem outro valor.
  const pieces = base
    .split(/;|\n|,(?!\d)|\s+(?:e tambem|tambem|e também|também|e|mais|\+)\s+(?=.*\d)/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Junta pedaços sem valor ao próximo ("caiu o salário, 4.850").
  const parts: string[] = [];
  let pending = '';
  for (const p of pieces) {
    const merged = pending ? `${pending} ${p}` : p;
    if (pickAmount(extractInstallment(merged).text)) {
      parts.push(merged);
      pending = '';
    } else pending = merged;
  }

  const prepared = parts.map((p) => {
    const { text, inst } = extractInstallment(p);
    return { raw: p, text, inst, date: findDate(flat(text), today) };
  });
  // Uma data dita uma vez vale para todos os itens ("ontem gastei 30 no uber e 25 na farmácia").
  const dated = prepared.filter((p) => p.date);
  const sharedDate = dated.length === 1 ? dated[0].date : null;

  const items: RuleItem[] = [];
  let lastKind: Kind | null = null;
  let lastDate: string | null = null;

  for (const p of prepared) {
    const f = flat(p.raw);
    const clean = blankOut(blankOut(p.text, PAYMENT_METHODS), DATE_TEXT);
    const amount = pickAmount(clean);
    if (!amount) continue;

    const rest = clean.slice(0, amount.index) + ' ' + clean.slice(amount.index + amount.length);
    let description = extractDescription(rest);

    const verbKind: Kind | null = IN_VERBS.test(f) ? 'entrada' : OUT_VERBS.test(f) ? 'saida' : null;
    const hint = categoryFromHistory(description, verbKind, history);
    const kind: Kind = verbKind ?? hint?.kind ?? (INCOME_WORDS.test(f) ? 'entrada' : null) ?? lastKind ?? 'saida';
    lastKind = kind;

    const category = hint && hint.kind === kind ? hint.category : categoryFromKeywords(`${f} ${flat(description)}`, kind);
    if (!description) description = category;

    let amountCents = amount.cents;
    if (p.inst) {
      if (p.inst.divide) amountCents = Math.round(amountCents / p.inst.total);
      description = `${description} (${p.inst.current}/${p.inst.total})`;
    }

    const date = sharedDate ?? p.date ?? lastDate ?? today;
    if (p.date) lastDate = p.date;

    items.push({ kind, category, amountCents, date, description, isFixed: Boolean(p.inst) || fixedAll });
  }
  return items;
}
