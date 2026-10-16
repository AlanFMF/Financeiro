import { normalize } from '../lib/csv.js';
import { parseMoneyToCents } from '../lib/money.js';

/**
 * Modo simples, usado quando não há chave da API da Claude configurada.
 * Entende frases curtas como "gastei 45,90 no mercado", "paguei 150 de condomínio ontem"
 * ou "recebi 4200 de salário". Várias de uma vez, separadas por vírgula, "e" ou ponto e vírgula.
 */

const OUT_VERBS = /\b(gastei|paguei|comprei|saiu|torrei|debitou|transferi|pix pra|pix para)\b/;
const IN_VERBS = /\b(recebi|ganhei|entrou|caiu|vendi|depositaram|me pagaram)\b/;

/** Palavra-chave → categoria padrão. A primeira que bater vence. */
const KEYWORDS: [RegExp, string][] = [
  [/salario|pro-?labore|holerite/, 'Pró-labore/Salário'],
  [/freela|bico|extra|venda|vendi/, 'Extra'],
  [/aluguel|condominio|luz|energia|agua|gas\b|iptu/, 'Moradia'],
  [/internet|celular|telefone|plano|fatura/, 'Contas'],
  [/mercado|supermercado|padaria|feira|restaurante|lanche|ifood|almoco|janta|cafe|pizza|acougue|hortifruti/, 'Alimentação'],
  [/gasolina|combustivel|etanol|uber|99|onibus|metro|estacionamento|pedagio|ipva|seguro do carro|oficina|financiamento/, 'Transporte'],
  [/farmacia|remedio|medico|dentista|exame|consulta|plano de saude/, 'Saúde'],
  [/racao|veterinario|pet|banho e tosa/, 'Pet'],
  [/netflix|spotify|youtube|prime|hbo|disney|assinatura|google one|icloud|claude|chatgpt/, 'Assinaturas'],
  [/curso|faculdade|pos|livro|escola|mensalidade/, 'Educação'],
  [/cinema|show|bar|viagem|passeio|jogo|steam|balada/, 'Lazer'],
  [/barbearia|cabelo|salao|manicure|perfume|academia/, 'Cuidados pessoais'],
  [/roupa|tenis|loja|shopping|presente|amazon|mercado livre|shopee/, 'Compras'],
  [/investi|aplicacao|tesouro|cdb|acoes|reserva/, 'Investimentos']
];

export interface RuleItem {
  kind: 'entrada' | 'saida';
  category: string;
  amountCents: number;
  date: string;
  description: string;
}

function shiftDate(today: string, days: number) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function findDate(text: string, today: string): string {
  if (/\banteontem\b/.test(text)) return shiftDate(today, -2);
  if (/\bontem\b/.test(text)) return shiftDate(today, -1);
  const m = text.match(/\bdia (\d{1,2})\b/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      const candidate = `${today.slice(0, 8)}${String(day).padStart(2, '0')}`;
      if (!Number.isNaN(Date.parse(candidate)) && candidate.slice(5, 7) === today.slice(5, 7)) return candidate;
    }
  }
  return today;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const DATE_WORDS = /(^|\s)(ontem|anteontem|hoje|dia \d{1,2})(?=\s|$)/g;

export function parseByRules(message: string, today: string): RuleItem[] {
  // Trabalha no texto original (com acentos) para a descrição e numa cópia sem acentos para as regras.
  const text = message.toLowerCase().replace(/\s+/g, ' ').trim();
  const flat = normalize(text);
  const globalKind: 'entrada' | 'saida' | null = IN_VERBS.test(flat) ? 'entrada' : OUT_VERBS.test(flat) ? 'saida' : null;

  const parts = text.split(/;|,(?!\d)|\s+e\s+(?=[^,;]*\d)/).map((p) => p.trim()).filter(Boolean);
  const items: RuleItem[] = [];

  for (const part of parts) {
    const partFlat = normalize(part);
    const date = findDate(partFlat, today);
    const clean = part.replace(DATE_WORDS, ' ').replace(/\s+/g, ' ').trim();

    const amountMatch = clean.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(\s*(?:reais|conto|pila)\b)?/);
    if (!amountMatch) continue;
    const cents = parseMoneyToCents(amountMatch[1]);
    if (!cents || cents <= 0) continue;

    const kind = IN_VERBS.test(partFlat) ? 'entrada' : OUT_VERBS.test(partFlat) ? 'saida' : globalKind ?? 'saida';

    // Descrição: o que vem depois de "no/na/de/com/em/pro" ou, se não houver, o que vem antes do valor.
    const after = clean.slice((amountMatch.index ?? 0) + amountMatch[0].length);
    const before = clean.slice(0, amountMatch.index ?? 0);
    const descSource =
      after.match(/(?:^|\s)(?:no|na|nos|nas|de|do|da|com|em|pro|pra|para|pelo|pela)\s+(.+)/)?.[1] ??
      normalize(before).replace(OUT_VERBS, '').replace(IN_VERBS, '').trim();
    const description = capitalize(descSource.replace(/\s+/g, ' ').trim()).slice(0, 60);

    const haystack = `${partFlat} ${normalize(description)}`;
    let category = kind === 'entrada' ? 'Outras receitas' : 'Imprevistos/Outros';
    for (const [re, cat] of KEYWORDS) {
      const isIncomeCat = ['Pró-labore/Salário', 'Extra'].includes(cat);
      if (re.test(haystack) && isIncomeCat === (kind === 'entrada')) {
        category = cat;
        break;
      }
    }

    items.push({ kind, category, amountCents: cents, date, description: description || category });
  }
  return items;
}
