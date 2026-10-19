/**
 * Documentação da API (OpenAPI 3.1), servida em /openapi.json e navegável em /docs.
 * Os formatos espelham as validações Zod das rotas; o teste openapi.test.ts confere que toda rota registrada
 * está documentada aqui.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required
});
const int = { type: 'integer' };
const str = { type: 'string' };
const bool = { type: 'boolean' };
const cents = { type: 'integer', description: 'Valor em centavos (R$ 45,90 = 4590)' };
const date = { type: 'string', format: 'date', example: '2026-10-17' };
const month = { type: 'string', pattern: '^\\d{4}-\\d{2}$', example: '2026-10' };
const idPath = { name: 'id', in: 'path', required: true, schema: int };
const errors = {
  400: json(ref('Error'), 'Dados inválidos'),
  401: json(ref('Error'), 'Sem login ou sessão expirada')
};

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Saldo API',
    version: '1.0.0',
    description:
      'API do Saldo, app de controle financeiro pessoal. Valores sempre em centavos inteiros. Todas as rotas, exceto as de autenticação e saúde, pedem `Authorization: Bearer <token>`; cada usuário só enxerga os próprios dados.',
    contact: { name: 'Alan Fabrício de Morais Filho', url: 'https://github.com/AlanFMF/Financeiro' },
    license: { name: 'MIT' }
  },
  servers: [{ url: '/', description: 'Este servidor' }],
  tags: [
    { name: 'Conta' },
    { name: 'Lançamentos' },
    { name: 'Categorias e metas' },
    { name: 'Resumo' },
    { name: 'Assistente' },
    { name: 'WhatsApp', description: 'Assistente pelo WhatsApp (Cloud API oficial da Meta)' },
    { name: 'Telegram', description: 'Assistente pelo Telegram (Bot API oficial)' },
    { name: 'Banco e conector', description: 'Chaves de menor privilégio para a tarefa agendada e para o conector do Claude' }
  ],
  security: [{ jwt: [] }],
  components: {
    securitySchemes: {
      jwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de /api/auth/login, /register ou /demo' },
      syncKey: { type: 'http', scheme: 'bearer', description: 'Chave `saldo_…` de escopo `sync`: só /api/sync' },
      mcpKey: { type: 'http', scheme: 'bearer', description: 'Chave `saldo_…` de escopo `mcp`: só /mcp' },
      notifyKey: { type: 'http', scheme: 'bearer', description: 'Chave `saldo_…` de escopo `notify`: só /api/notifications' }
    },
    schemas: {
      Error: obj({ error: str }, ['error']),
      User: obj({ id: int, name: str, email: { type: 'string', format: 'email' }, isDemo: bool }),
      Auth: obj({ token: str, user: ref('User') }),
      Category: obj({
        id: int,
        name: str,
        kind: { type: 'string', enum: ['entrada', 'saida'] },
        color: { type: 'string', example: '#B5772E' },
        position: int,
        archived: bool,
        transactionCount: int,
        budgetCents: { type: ['integer', 'null'], description: 'Meta mensal (só saídas)' }
      }),
      Transaction: obj(
        {
          id: int,
          date,
          description: str,
          amountCents: cents,
          isFixed: bool,
          source: { type: ['string', 'null'], description: 'Fonte da sincronização, como "Nubank cartão"' },
          needsReview: { type: 'boolean', description: 'Veio do banco e ainda não foi conferido' },
          categoryId: int,
          categoryName: str,
          kind: { type: 'string', enum: ['entrada', 'saida'] },
          color: str
        },
        ['id', 'date', 'description', 'amountCents', 'isFixed', 'categoryId', 'categoryName', 'kind', 'color']
      ),
      TransactionInput: obj(
        {
          categoryId: int,
          date,
          description: { type: 'string', maxLength: 120 },
          amountCents: cents,
          isFixed: bool,
          clientId: { type: 'string', description: 'Id gerado no aparelho para lançamento feito sem internet: reenviar não duplica' }
        },
        ['categoryId', 'date', 'amountCents']
      ),
      Budget: obj({
        categoryId: int,
        name: str,
        color: str,
        budgetCents: cents,
        spentCents: cents,
        remainingCents: cents,
        pct: int,
        level: { type: 'integer', enum: [0, 80, 100] }
      }),
      BudgetAlert: obj({ categoryId: int, level: { type: 'integer', enum: [80, 100] }, message: str }),
      Forecast: obj({
        endDate: date,
        daysLeft: int,
        balanceCents: cents,
        pendingIncomeCents: cents,
        pendingFixedExpenseCents: cents,
        dailyVariableCents: cents,
        remainingVariableCents: cents,
        projectedBalanceCents: cents,
        basis: { type: 'string', enum: ['historico', 'mes_atual', 'misto'] },
        pending: { type: 'array', items: obj({ description: str, categoryName: str, kind: str, amountCents: cents }) }
      }),
      Summary: obj({
        month,
        income: cents,
        expense: cents,
        balance: cents,
        fixedExpense: cents,
        previous: obj({ income: cents, expense: cents, balance: cents }),
        byCategory: { type: 'array', items: obj({ id: int, name: str, kind: str, color: str, total: cents, count: int }) },
        forecast: { oneOf: [ref('Forecast'), { type: 'null' }], description: 'Só no mês corrente' }
      }),
      Token: obj({
        id: int,
        name: str,
        scope: { type: 'string', enum: ['sync', 'mcp', 'notify'] },
        hint: { type: 'string', description: 'Últimos 4 caracteres' },
        createdAt: { type: 'string', format: 'date-time' },
        lastUsedAt: { type: ['string', 'null'], format: 'date-time' }
      }),
      BankItem: obj(
        {
          externalId: str,
          date,
          amountCents: cents,
          kind: { type: 'string', enum: ['entrada', 'saida'] },
          description: str,
          bankCategory: str,
          status: { type: 'string', enum: ['POSTED', 'PENDING'] },
          installment: obj({ number: int, total: int })
        },
        ['externalId', 'date', 'amountCents', 'kind']
      )
    }
  },
  paths: {
    '/api/health': { get: { tags: ['Conta'], summary: 'Saúde da API e do banco', security: [], responses: { 200: json(obj({ ok: bool })) } } },
    '/api/ping': { get: { tags: ['Conta'], summary: 'Saúde sem tocar no banco', security: [], responses: { 200: json(obj({ ok: bool })) } } },
    '/api/auth/register': {
      post: {
        tags: ['Conta'],
        summary: 'Criar conta',
        security: [],
        requestBody: body(obj({ name: str, email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } })),
        responses: { 201: json(ref('Auth')), 400: errors[400], 409: json(ref('Error'), 'E-mail já cadastrado') }
      }
    },
    '/api/auth/login': {
      post: {
        tags: ['Conta'],
        summary: 'Entrar',
        security: [],
        requestBody: body(obj({ email: str, password: str })),
        responses: { 200: json(ref('Auth')), 401: errors[401] }
      }
    },
    '/api/auth/demo': {
      post: { tags: ['Conta'], summary: 'Conta temporária com dados fictícios (some em 24 h)', security: [], responses: { 200: json(ref('Auth')) } }
    },
    '/api/auth/me': { get: { tags: ['Conta'], summary: 'Usuário atual', responses: { 200: json(obj({ user: ref('User') })), 401: errors[401] } } },

    '/api/categories': {
      get: { tags: ['Categorias e metas'], summary: 'Listar categorias', responses: { 200: json(obj({ categories: { type: 'array', items: ref('Category') } })) } },
      post: {
        tags: ['Categorias e metas'],
        summary: 'Criar categoria',
        requestBody: body(obj({ name: str, kind: { type: 'string', enum: ['entrada', 'saida'] }, color: str }, ['name', 'kind'])),
        responses: { 201: json(obj({ category: ref('Category') })), ...errors, 409: json(ref('Error'), 'Nome repetido') }
      }
    },
    '/api/categories/{id}': {
      patch: {
        tags: ['Categorias e metas'],
        summary: 'Renomear, mudar a cor ou arquivar',
        parameters: [idPath],
        requestBody: body(obj({ name: str, color: str, archived: bool }, [])),
        responses: { 200: json(obj({ category: ref('Category') })), ...errors }
      },
      delete: {
        tags: ['Categorias e metas'],
        summary: 'Excluir categoria sem lançamentos',
        parameters: [idPath],
        responses: { 204: { description: 'Excluída' }, 409: json(ref('Error'), 'Tem lançamentos: arquive') }
      }
    },
    '/api/budgets': {
      get: {
        tags: ['Categorias e metas'],
        summary: 'Metas do mês: limite, gasto, quanto resta e faixa',
        parameters: [{ name: 'month', in: 'query', required: true, schema: month }],
        responses: { 200: json(obj({ month, budgets: { type: 'array', items: ref('Budget') } })) }
      }
    },
    '/api/budgets/{categoryId}': {
      put: {
        tags: ['Categorias e metas'],
        summary: 'Definir (ou remover com null) a meta mensal de uma categoria de saída',
        parameters: [{ name: 'categoryId', in: 'path', required: true, schema: int }],
        requestBody: body(obj({ budgetCents: { type: ['integer', 'null'] } })),
        responses: { 200: json(obj({ categoryId: int, budgetCents: { type: ['integer', 'null'] } })), ...errors, 404: json(ref('Error')) }
      }
    },
    '/api/budgets/alerts': {
      post: {
        tags: ['Categorias e metas'],
        summary: 'Avisos de 80% e 100% ainda não mostrados no mês (cada um sai uma vez)',
        requestBody: body(obj({ month })),
        responses: { 200: json(obj({ alerts: { type: 'array', items: ref('BudgetAlert') } })) }
      }
    },

    '/api/transactions': {
      get: {
        tags: ['Lançamentos'],
        summary: 'Listar lançamentos',
        parameters: [
          { name: 'month', in: 'query', schema: month },
          { name: 'categoryId', in: 'query', schema: int },
          { name: 'q', in: 'query', schema: str, description: 'Busca na descrição e na categoria' },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000 } }
        ],
        responses: { 200: json(obj({ transactions: { type: 'array', items: ref('Transaction') } })) }
      },
      post: {
        tags: ['Lançamentos'],
        summary: 'Lançar',
        requestBody: body(ref('TransactionInput')),
        responses: { 201: json(obj({ transaction: ref('Transaction') })), ...errors }
      }
    },
    '/api/transactions/{id}': {
      put: {
        tags: ['Lançamentos'],
        summary: 'Editar (também marca como conferido)',
        parameters: [idPath],
        requestBody: body(ref('TransactionInput')),
        responses: { 200: json(obj({ transaction: ref('Transaction') })), ...errors, 404: json(ref('Error')) }
      },
      delete: { tags: ['Lançamentos'], summary: 'Excluir', parameters: [idPath], responses: { 204: { description: 'Excluído' }, 404: json(ref('Error')) } }
    },
    '/api/transactions/copy-fixed': {
      post: {
        tags: ['Lançamentos'],
        summary: 'Copiar os fixos de um mês para outro, avançando parcelas',
        requestBody: body(obj({ from: month, to: month })),
        responses: { 200: json(obj({ created: int, skipped: int, finished: int })) }
      }
    },
    '/api/transactions/review': {
      get: {
        tags: ['Lançamentos'],
        summary: 'Importados do banco ainda não conferidos',
        responses: { 200: json(obj({ transactions: { type: 'array', items: ref('Transaction') } })) }
      }
    },
    '/api/transactions/review/confirm': {
      post: {
        tags: ['Lançamentos'],
        summary: 'Confirmar importados como estão',
        requestBody: body(obj({ ids: { type: 'array', items: int } })),
        responses: { 200: json(obj({ confirmed: int })) }
      }
    },
    '/api/transactions/review/{id}': {
      post: {
        tags: ['Lançamentos'],
        summary: 'Trocar a categoria de um importado; os iguais a conferir vão junto',
        parameters: [idPath],
        requestBody: body(obj({ categoryId: int })),
        responses: { 200: json(obj({ updated: { type: 'array', items: int } })), ...errors, 404: json(ref('Error')) }
      }
    },
    '/api/import/csv': {
      post: {
        tags: ['Lançamentos'],
        summary: 'Importar CSV da planilha (prévia com dryRun)',
        requestBody: body(obj({ csv: str, year: int, dryRun: bool }, ['csv'])),
        responses: { 200: { description: 'Prévia ou resultado da importação' }, ...errors }
      }
    },
    '/api/export.csv': {
      get: {
        tags: ['Lançamentos'],
        summary: 'Exportar CSV no formato da planilha',
        parameters: [{ name: 'year', in: 'query', schema: int }],
        responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: str } } } }
      }
    },

    '/api/events': {
      get: {
        tags: ['Resumo'],
        summary: 'Avisos em tempo real (Server-Sent Events) quando os dados do usuário mudam',
        description:
          'Fica aberto. Envia `event: changed` com `{ source, at }` a cada mudança, venha do app (source = cabeçalho X-Client-Id de quem mudou), do Telegram, do WhatsApp, do Claude ou da sincronização com o banco.',
        responses: { 200: { description: 'Fluxo de eventos', content: { 'text/event-stream': { schema: str } } }, 401: json(ref('Error')) }
      }
    },
    '/api/summary': {
      get: {
        tags: ['Resumo'],
        summary: 'Totais do mês, comparação com o anterior, total por categoria e previsão',
        parameters: [
          { name: 'month', in: 'query', required: true, schema: month },
          { name: 'today', in: 'query', schema: date, description: 'Data de hoje do aparelho, para a previsão' }
        ],
        responses: { 200: json(ref('Summary')) }
      }
    },
    '/api/summary/history': {
      get: {
        tags: ['Resumo'],
        summary: 'Entradas e saídas dos últimos meses',
        parameters: [
          { name: 'month', in: 'query', required: true, schema: month },
          { name: 'months', in: 'query', schema: { type: 'integer', minimum: 2, maximum: 24 } }
        ],
        responses: { 200: json(obj({ series: { type: 'array', items: obj({ month, income: cents, expense: cents }) } })) }
      }
    },

    '/api/assistant/chat': {
      post: {
        tags: ['Assistente'],
        summary: 'Conversar com o assistente (IA do usuário ou modo simples por regras)',
        requestBody: body(
          obj(
            {
              messages: { type: 'array', items: obj({ role: { type: 'string', enum: ['user', 'assistant'] }, content: str }) },
              today: date
            },
            ['messages']
          )
        ),
        responses: {
          200: json(
            obj({
              reply: str,
              transactions: { type: 'array', items: ref('Transaction') },
              updated: { type: 'array', items: ref('Transaction') },
              deleted: { type: 'array', items: ref('Transaction') },
              alerts: { type: 'array', items: ref('BudgetAlert') },
              mode: { type: 'string', enum: ['ia', 'simples'] }
            })
          ),
          429: json(ref('Error'), 'Limite de mensagens por hora')
        }
      }
    },
    '/api/assistant/status': {
      get: {
        tags: ['Assistente'],
        summary: 'Modo do assistente',
        responses: { 200: json(obj({ mode: { type: 'string', enum: ['ia', 'simples'] }, provider: { type: ['string', 'null'] } }, ['mode'])) }
      }
    },
    '/api/assistant/settings': {
      get: { tags: ['Assistente'], summary: 'IA conectada (sem a chave)', responses: { 200: { description: 'Provedor, modelo e final da chave' } } },
      put: {
        tags: ['Assistente'],
        summary: 'Conectar Claude, ChatGPT ou Gemini com a chave do usuário (testada e guardada criptografada)',
        requestBody: body(obj({ provider: { type: 'string', enum: ['claude', 'openai', 'gemini'] }, apiKey: str, model: str }, ['provider'])),
        responses: { 200: { description: 'Conectado' }, ...errors }
      },
      delete: { tags: ['Assistente'], summary: 'Desconectar a IA', responses: { 204: { description: 'Desconectada' } } }
    },

    '/api/tokens': {
      get: { tags: ['Banco e conector'], summary: 'Listar chaves', responses: { 200: json(obj({ tokens: { type: 'array', items: ref('Token') } })) } },
      post: {
        tags: ['Banco e conector'],
        summary: 'Criar chave (aparece uma única vez)',
        requestBody: body(obj({ name: str, scope: { type: 'string', enum: ['sync', 'mcp', 'notify'] } }, ['name'])),
        responses: { 201: json(obj({ token: str, info: ref('Token') })), ...errors }
      }
    },
    '/api/tokens/{id}': {
      delete: { tags: ['Banco e conector'], summary: 'Revogar chave', parameters: [idPath], responses: { 204: { description: 'Revogada' } } }
    },
    '/api/sync/bank': {
      post: {
        tags: ['Banco e conector'],
        summary: 'Receber transações do banco sem duplicar',
        security: [{ syncKey: [] }, { jwt: [] }],
        requestBody: body(obj({ source: str, notBefore: date, items: { type: 'array', maxItems: 500, items: ref('BankItem') } }, ['source', 'items'])),
        responses: {
          200: json(
            obj({
              created: int,
              linked: int,
              skipped: int,
              ignored: int,
              summary: obj({ saida: obj({ count: int, cents }), entrada: obj({ count: int, cents }) }),
              alerts: { type: 'array', items: ref('BudgetAlert') },
              items: { type: 'array', items: { type: 'object' } }
            })
          ),
          ...errors,
          403: json(ref('Error'), 'Chave de outro escopo')
        }
      }
    },
    '/api/sync/status': {
      get: {
        tags: ['Banco e conector'],
        summary: 'Última sincronização',
        security: [{ syncKey: [] }, { jwt: [] }],
        responses: { 200: json(obj({ lastSyncAt: { type: ['string', 'null'] }, importedRefs: int })) }
      }
    },
    '/api/notifications': {
      get: {
        tags: ['Banco e conector'],
        summary: 'Notificações para o celular (metas e importações novas), entregues uma vez',
        description: 'Chamada pelo app instalado em segundo plano. A primeira chamada só marca o ponto de partida das importações.',
        security: [{ notifyKey: [] }, { jwt: [] }],
        responses: {
          200: json(
            obj({
              notifications: {
                type: 'array',
                items: obj({ id: int, title: str, body: str, kind: { type: 'string', enum: ['meta', 'importados'] } })
              }
            })
          ),
          403: json(ref('Error'), 'Chave de outro escopo')
        }
      }
    },
    '/api/whatsapp': {
      get: {
        tags: ['WhatsApp'],
        summary: 'Se o WhatsApp está ligado no servidor e qual número está ligado à conta',
        responses: {
          200: json(
            obj({
              enabled: bool,
              number: { type: ['string', 'null'] },
              chatLink: { type: ['string', 'null'] },
              linked: { oneOf: [obj({ number: str, linkedAt: { type: 'string', format: 'date-time' } }), { type: 'null' }] }
            })
          )
        }
      }
    },
    '/api/whatsapp/code': {
      post: {
        tags: ['WhatsApp'],
        summary: 'Código de 6 dígitos (15 min) para ligar um número de WhatsApp à conta',
        responses: { 200: json(obj({ code: str, expiresAt: { type: 'string', format: 'date-time' }, link: { type: ['string', 'null'] } })), 503: json(ref('Error')) }
      }
    },
    '/api/whatsapp/link': {
      delete: { tags: ['WhatsApp'], summary: 'Desligar o número de WhatsApp da conta', responses: { 204: { description: 'Desligado' } } }
    },
    '/api/whatsapp/webhook': {
      get: {
        tags: ['WhatsApp'],
        summary: 'Verificação do webhook pela Meta (hub.mode, hub.verify_token, hub.challenge)',
        security: [],
        responses: { 200: { description: 'Devolve hub.challenge', content: { 'text/plain': { schema: str } } }, 403: json(ref('Error')) }
      },
      post: {
        tags: ['WhatsApp'],
        summary: 'Mensagens recebidas, assinadas pela Meta (X-Hub-Signature-256)',
        security: [],
        requestBody: body({ type: 'object', description: 'Notificação da WhatsApp Cloud API' }),
        responses: { 200: { description: 'Recebido (processado em seguida)' }, 401: json(ref('Error'), 'Assinatura inválida') }
      }
    },
    '/api/telegram': {
      get: {
        tags: ['Telegram'],
        summary: 'Se o bot está ligado no servidor, qual é o @ dele e se a conta já está ligada',
        responses: {
          200: json(
            obj({
              enabled: bool,
              bot: { type: ['string', 'null'] },
              chatLink: { type: ['string', 'null'] },
              linked: { oneOf: [obj({ linkedAt: { type: 'string', format: 'date-time' } }), { type: 'null' }] }
            })
          )
        }
      }
    },
    '/api/telegram/code': {
      post: {
        tags: ['Telegram'],
        summary: 'Código de 6 dígitos e link t.me/<bot>?start=<código> que liga a conversa à conta',
        responses: { 200: json(obj({ code: str, expiresAt: { type: 'string', format: 'date-time' }, link: { type: ['string', 'null'] } })), 503: json(ref('Error')) }
      }
    },
    '/api/telegram/link': {
      delete: { tags: ['Telegram'], summary: 'Desligar a conversa do Telegram da conta', responses: { 204: { description: 'Desligada' } } }
    },
    '/api/telegram/webhook': {
      post: {
        tags: ['Telegram'],
        summary: 'Atualizações do Telegram (cabeçalho X-Telegram-Bot-Api-Secret-Token obrigatório)',
        description: 'Só conversas privadas com o bot são atendidas. O webhook é registrado pelo servidor ao iniciar.',
        security: [],
        requestBody: body({ type: 'object', description: 'Update da Bot API' }),
        responses: { 200: { description: 'Recebido (processado em seguida)' }, 401: json(ref('Error'), 'Segredo não confere') }
      }
    },
    '/mcp': {
      post: {
        tags: ['Banco e conector'],
        summary: 'Conector do Claude (MCP, Streamable HTTP sem sessão)',
        description:
          'JSON-RPC do Model Context Protocol. Ferramentas: registrar_lancamentos, corrigir_lancamento, excluir_lancamento, consultar_lancamentos, consultar_metas, definir_meta, previsao_do_mes, resumo_do_mes. A chave também pode ir no caminho: /mcp/{chave}.',
        security: [{ mcpKey: [] }],
        requestBody: body({ type: 'object', description: 'Mensagem JSON-RPC 2.0' }),
        responses: { 200: { description: 'Resposta JSON-RPC' }, 401: json(ref('Error'), 'Chave inválida ou de outro escopo') }
      }
    }
  }
} as const;

/** Página com o Swagger UI apontando para /openapi.json. */
export const docsHtml = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Saldo API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>body{margin:0;background:#fafafa}.topbar{display:none}</style>
</head>
<body>
  <div id="docs"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: 'openapi.json', dom_id: '#docs', deepLinking: true, persistAuthorization: true, tryItOutEnabled: false });
  </script>
</body>
</html>`;
