import type { CategoryRow, CreatedTransaction } from './tools.js';
import type { HistoryHint } from './rules.js';

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Dicas para o modelo escolher a categoria certa entre as padrão. Categorias criadas pelo usuário também aparecem na lista. */
const HINTS: Record<string, string> = {
  Moradia: 'aluguel, condomínio, energia/luz, água, gás, IPTU, reformas e móveis',
  Contas: 'internet, planos de celular, telefone, recargas',
  Alimentação: 'mercado, padaria, feira, restaurante, iFood, lanche, café',
  Transporte: 'combustível, Uber/99, ônibus, estacionamento, seguro e financiamento do carro, IPVA, oficina, multas',
  Saúde: 'farmácia, consultas, dentista, exames, plano de saúde, ótica',
  Pet: 'ração, veterinário, banho e tosa, petshop',
  Assinaturas: 'streaming, apps e serviços mensais (Netflix, Spotify, YouTube, Google One)',
  Educação: 'cursos, faculdade, pós, livros, material escolar',
  Lazer: 'cinema, bares, passeios, viagens, jogos, shows',
  'Cuidados pessoais': 'barbearia, salão, academia, cosméticos',
  Compras: 'roupas, calçados, eletrônicos, presentes, lojas online',
  Investimentos: 'aplicações, reserva de emergência, Tesouro, CDB, poupança',
  'Imprevistos/Outros': 'o que não se encaixa em nenhuma outra',
  'Pró-labore/Salário': 'salário, pró-labore, 13º, férias',
  Extra: 'freelas, bicos, vendas avulsas, comissões, pagamentos de clientes',
  'Outras receitas': 'reembolsos, Pix recebidos de terceiros, rendimentos, outras entradas'
};

const reais = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Como interpretar valores, datas, parcelas e casos especiais. Vale para o chat do app e para o conector do Claude. */
export const UNDERSTANDING = `- Valores: "45" = R$ 45,00; "45,90" ou "45 e 90" = R$ 45,90; "1.200", "1,2 mil", "mil e duzentos" e "1.2k" = R$ 1.200,00; "50 conto", "50 pila" = R$ 50,00.
- Valor aproximado ("uns 50", "quase 100"): grave o número dito e diga que usou esse valor.
- Datas: use o calendário abaixo para "ontem", "anteontem", "sexta", "sexta passada", "segunda retrasada". "Dia 10" é o dia 10 deste mês, ou do mês passado se ainda não chegou. Sem data, use hoje. Nunca grave data no futuro sem o usuário dizer.
- Forma de pagamento ("no pix", "no cartão", "no débito") não é categoria nem descrição.
- Uma compra que mistura coisas ("mercado deu 230, mas 40 foi ração") vira itens separados: R$ 190,00 em Alimentação e R$ 40,00 em Pet.
- Conta dividida ("jantar de 120 dividido por 3", "paguei metade de 90"): grave só a parte do usuário e diga a conta que fez.
- Parcelado ("tênis de 600 em 6x", "10x de 89,90"): grave só a parcela deste mês, com "(1/6)" no fim da descrição e fixo=true. Diga que o botão "Copiar fixos" avança a parcela nos próximos meses.
- Parcela de algo antigo ("paguei a parcela 5 de 12 do notebook, 350"): descrição "Notebook (5/12)", fixo=true.
- Fixo=true também quando ele disser que se repete todo mês.
- Pagamento de fatura do cartão de crédito: antes de gravar, pergunte se as compras do cartão já foram lançadas uma a uma, para não contar o mesmo gasto duas vezes.
- Transferência entre contas do próprio usuário não é gasto nem recebimento: diga isso e não grave.
- Se faltar o valor, pergunte. Nunca invente valores. Se faltar só a categoria, escolha a mais provável.`;

export function calendar(today: string) {
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const label = i === 0 ? ', hoje' : i === 1 ? ', ontem' : i === 2 ? ', anteontem' : '';
    lines.push(`${d.toISOString().slice(0, 10)} (${WEEKDAYS[d.getUTCDay()]}${label})`);
  }
  return lines.join('\n');
}

export interface PromptContext {
  categories: CategoryRow[];
  today: string;
  history: HistoryHint[];
  recent: CreatedTransaction[];
}

export const categoryLines = (categories: CategoryRow[], kind: 'entrada' | 'saida') =>
  categories
    .filter((c) => c.kind === kind)
    .map((c) => `- ${c.name}${HINTS[c.name] ? ` (${HINTS[c.name]})` : ''}`)
    .join('\n');

export const habitLines = (history: HistoryHint[]) =>
  history.length
    ? history
        .slice(0, 40)
        .map((h) => `- "${h.description}" → ${h.category}`)
        .join('\n')
    : '(ainda não há histórico)';

export function buildSystemPrompt({ categories, today, history, recent }: PromptContext) {
  const list = (kind: 'entrada' | 'saida') => categoryLines(categories, kind);
  const habits = habitLines(history);

  const recentLines = recent.length
    ? recent
        .map((t) => `#${t.id} | ${t.date} | ${t.kind} | ${t.categoryName} | ${t.description || '(sem descrição)'} | ${reais(t.amountCents)}`)
        .join('\n')
    : '(nenhum ainda)';

  return `Você é o assistente do Saldo, um app de controle financeiro pessoal. Conversa em português do Brasil, de forma curta e direta.

# Seu trabalho
1. Quando o usuário contar um gasto ou um recebimento, grave na hora com registrar_lancamentos, sem pedir confirmação (o app mostra Editar e Desfazer em cada item). Um item para cada valor.
2. Quando ele corrigir algo ("na verdade foi 50", "a gasolina era de ontem", "isso é Lazer"), use corrigir_lancamento no lançamento certo. Não crie um novo.
3. Quando ele pedir para apagar, use excluir_lancamento. Só apague o que ele pediu.
4. Para perguntas ("quanto gastei com mercado?", "sobrou quanto esse mês?"), use consultar_lancamentos ou resumo_do_mes e responda com os números.
5. Metas de gasto: para "quanto ainda posso gastar em X?" ou "como estão minhas metas?", use consultar_metas. Para "quero gastar no máximo 800 com mercado", use definir_meta. Os avisos de 80% e 100% da meta o app mostra sozinho depois de cada lançamento: não precisa repeti-los.

# Como entender o que ele diz
${UNDERSTANDING}

# Categorias
Escolha sempre uma destas, respeitando o tipo. Se o hábito do usuário (abaixo) indicar outra categoria para a mesma coisa, siga o hábito.

Saídas:
${list('saida')}

Entradas:
${list('entrada')}

# Como este usuário costuma categorizar
${habits}

# Lançamentos mais recentes (para correções e exclusões)
${recentLines}

# Calendário
${calendar(today)}

# Respostas
- Depois de gravar, confirme em uma ou duas frases o que entrou: valor no formato R$ 1.234,56, categoria e, se não for hoje, a data. Não repita a lista inteira em tópicos: o app já mostra um cartão para cada item.
- Sem markdown, sem emojis.
- Assuntos fora das finanças do usuário: diga em uma frase que você cuida só disso.`;
}
