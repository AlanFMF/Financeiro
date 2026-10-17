# Saldo

**[English version](README.en.md)** · [Documentação da API](https://saldo-api-g1ae.onrender.com/docs)

[![CI](https://github.com/AlanFMF/Financeiro/actions/workflows/ci.yml/badge.svg)](https://github.com/AlanFMF/Financeiro/actions/workflows/ci.yml)
[![Android e Pages](https://github.com/AlanFMF/Financeiro/actions/workflows/android.yml/badge.svg)](https://github.com/AlanFMF/Financeiro/actions/workflows/android.yml)

Controle financeiro pessoal que funciona no computador e se instala no celular como app. Você lança entradas e saídas em poucos toques, vê o saldo do mês e descobre para onde o dinheiro está indo.

Nasceu de uma planilha real do Google Sheets que eu uso para organizar as finanças de casa. O Saldo importa essa planilha, mantém as mesmas categorias e exporta de volta no mesmo formato.

> **Use agora:** [alanfmf.github.io/Financeiro/app](https://alanfmf.github.io/Financeiro/app/) no navegador, ou baixe o APK em [alanfmf.github.io/Financeiro](https://alanfmf.github.io/Financeiro/). Para só conhecer, toque em *Abrir a demonstração*: cria uma conta temporária com quatro meses de dados fictícios.

<p>
  <img src="docs/screens/assistente.gif" width="240" alt="Assistente lançando 'gastei 230 no mercado, mas 40 foi ração' em dois itens, avisando que a meta de Alimentação estourou e respondendo quanto ainda dá para gastar">
  <img src="docs/screens/mes-light.png" width="240" alt="Tela do mês com saldo, régua de gastos, previsão para o fim do mês e metas por categoria">
  <img src="docs/screens/conferir.png" width="240" alt="Lista de lançamentos importados do Nubank para conferir a categoria">
</p>
<p>
  <img src="docs/screens/metas.png" width="240" alt="Previsão do fim do mês aberta, com a conta, e as barras de metas">
  <img src="docs/mobile-lancamento.png" width="240" alt="Formulário de novo lançamento com valor, categoria e data">
  <img src="docs/screens/mes-dark.png" width="240" alt="Tela do mês no modo escuro">
</p>
<img src="docs/desktop-assistente.png" width="760" alt="Tela do mês no computador com o assistente aberto no canto">

## O que ele faz

- **Assistente com IA no canto da tela**: escreva ou fale "gastei 45,90 no mercado e 120 de gasolina ontem" e ele lança os dois na categoria certa, com a data certa. Cada lançamento aparece no chat com **Editar** e **Desfazer**. Entende frases como "mercado deu 230, mas 40 foi ração" (separa em dois), "tênis de 600 em 6x no cartão" (lança a parcela 1/6), "jantar de 120 dividido por 3", e correções como "na verdade a gasolina foi 160" ou "apaga o do uber". Também responde perguntas como "quanto gastei com alimentação este mês?".
- **Saldo do mês em destaque**, com uma régua que mostra quanto do que entrou já saiu e a comparação com o mês anterior.
- **Lançamento rápido pelo celular**: teclado numérico, categorias em botões, data já preenchida. O atalho do ícone instalado abre direto o formulário.
- **Gastos fixos e parcelas**: marque um lançamento como fixo e copie todos para o mês seguinte com um toque. Descrições como `Financiamento (10/48)` avançam sozinhas para `(11/48)`, e a parcela final não é copiada.
- **Previsão do fim do mês**: junto do saldo de hoje, quanto deve sobrar (ou faltar) no último dia: fixos do mês passado que ainda não apareceram, sem contar duas vezes o aluguel que veio do banco com outro nome, mais o ritmo dos gastos do dia a dia. Um toque abre a conta. O assistente responde "vou fechar o mês no azul?".
- **Notificações no celular** (APK): em Ajustes → Notificações no celular, o app pede a permissão do Android e passa a avisar quando uma meta chega a 80% ou é atingida e quando entram lançamentos do banco para conferir, mesmo fechado. Um executor em segundo plano (Capacitor Background Runner) pergunta ao servidor a cada ~30 minutos com uma chave que só lê `/api/notifications`, então não depende de Firebase nem de conta extra.
- **Conferir importados**: o que vem do banco entra na lista "a conferir" com a categoria que o app escolheu. Trocar a categoria confirma, leva junto os outros iguais ("Kachin" duas vezes) e ensina o app, que acerta sozinho na próxima importação.
- **Para onde foi**: total e percentual por categoria, histórico de seis meses e busca com filtro.
- **Metas por categoria**: um limite mensal por categoria de saída (mercado até R$ 800, por exemplo), com barra de andamento na tela do mês. O app avisa uma vez quando a categoria chega a 80% e outra quando atinge a meta, venha o gasto do formulário, do chat ou do banco. No chat dá para perguntar "quanto ainda posso gastar no mercado?" (a resposta inclui quanto dá por dia até o fim do mês) ou pedir "quero gastar no máximo 800 com mercado".
- **Importação da planilha**: CSV com Data, Categoria, Descrição, Entrada e Saída (ou extrato com coluna Valor). Mostra uma prévia, aponta linhas com erro, cria categorias novas e não duplica o que já foi importado.
- **Exportação** no mesmo formato da planilha.
- **Cada um usa a própria IA**: em Ajustes, a pessoa escolhe Claude, ChatGPT ou Gemini e cola a chave dela. A chave é testada antes de ser salva, fica criptografada no servidor e nunca volta para o aparelho. Sem chave, o assistente funciona no modo simples.
- **Conector do Claude**: em Ajustes → Usar no Claude, a pessoa cria uma chave e adiciona o Saldo como conector personalizado no Claude (site, computador ou celular). Daí em diante, "gastei 45 no mercado" ou "quanto ainda posso gastar em lazer?" dito no próprio Claude lança e consulta no Saldo, usando a assinatura dela, sem custo de API. São as mesmas ferramentas do chat do app, servidas por MCP.
- **Sincronização com o banco**: uma tarefa agendada no Claude lê a conta e o cartão pelo Open Finance todo dia às 22h e envia para o Saldo por uma chave que só pode enviar lançamentos. O servidor limpa as descrições do extrato ("Transferência enviada pelo Pix\|CEMIG" vira "Pix para Cemig"), escolhe a categoria pelo hábito do usuário e pela categoria do banco, e não duplica: reconhece o que já foi lançado à mão ou pelo chat, liga a compra pendente à confirmada e ignora o pagamento da fatura.
- **APK para Android** gerado automaticamente pelo GitHub Actions a cada envio de código, além da versão web instalável (PWA). Modo escuro automático e layout pensado primeiro para o celular.
- **Demonstração pública** sem expor dados reais: cada visitante ganha uma conta temporária que é apagada em 24 horas.

## Stack

| Camada | Tecnologias |
| --- | --- |
| API | Node.js 22, TypeScript, Fastify 5, Zod, JWT, bcrypt, rate limit |
| Banco | PostgreSQL 16 com SQL puro e migrações versionadas. Em desenvolvimento e nos testes roda em [PGlite](https://pglite.dev) (Postgres em WASM), sem instalar nada |
| Front | React 18, TypeScript, Vite, TanStack Query, React Router, vite-plugin-pwa |
| Android | Capacitor 8, APK montado e publicado pelo GitHub Actions |
| IA | Claude (Messages API), ChatGPT (Responses API) e Gemini (generateContent), com a chave de cada usuário, todos com chamada de ferramentas. Sem SDKs: um adaptador fino por provedor sobre `fetch` |
| Qualidade | Vitest (166 testes: API, metas, previsão, conferência de importados, interpretador de frases, adaptadores das IAs, assistente com IA simulada, ditado por voz, botão voltar, conector MCP com cliente real e cobertura da documentação), Playwright de ponta a ponta num celular emulado, GitHub Actions com PostgreSQL 16 real |
| Deploy | Vercel (front), Render (API), Neon (PostgreSQL), todos no plano gratuito |

## Decisões que valem a pena explicar

- **Dinheiro em centavos inteiros.** Nada de `float` para valores: `R$ 1.227,76` vira `122776`. Somas e comparações ficam exatas.
- **SQL escrito à mão em vez de ORM.** Os relatórios usam `sum(...) filter (where ...)`, `generate_series` para meses sem lançamento e `date_trunc`. Fica legível e mostra o que o banco está fazendo.
- **Uma interface `Db`, dois motores.** A mesma API roda em PostgreSQL (produção) ou PGlite (local e testes). Quem clona o repositório roda `npm run dev` e já tem um Postgres funcionando.
- **Isolamento por usuário em toda consulta.** Todo `select`, `update` e `delete` filtra por `user_id`, e há teste garantindo que um usuário não lê nem apaga dado de outro, nem usa a categoria de outro.
- **A IA não toca no banco.** O modelo só pode chamar sete ferramentas (`registrar_lancamentos`, `corrigir_lancamento`, `excluir_lancamento`, `consultar_lancamentos`, `consultar_metas`, `definir_meta`, `resumo_do_mes`). Quem valida valor, data e categoria e escreve no PostgreSQL é o código da API, sempre com o `user_id` de quem está logado. Ele recebe no prompt a data de hoje e as categorias do usuário, e o laço de ferramentas tem limite de rodadas.
- **A IA conhece o usuário.** O prompt leva os hábitos de categoria dele (a "Padaria do Zé" que ele sempre lança em Lazer), os últimos lançamentos com id (para corrigir e apagar o certo) e um calendário dos últimos dez dias, para "sexta passada" nunca virar a data errada.
- **Três IAs, uma interface.** Claude, ChatGPT e Gemini falam formatos diferentes de chamada de ferramentas. Cada um tem um adaptador pequeno que traduz para a mesma interface (`start` e `continue`), então o laço do assistente não sabe com qual IA está falando. No Gemini, o conteúdo do modelo volta intacto a cada rodada para preservar as *thought signatures*; no ChatGPT, as rodadas são encadeadas por `previous_response_id`.
- **Chave do usuário guardada com cuidado.** AES-256-GCM com um segredo do servidor (`AI_KEY_SECRET`); a chave é validada listando os modelos do provedor (não gasta tokens) e só os quatro últimos caracteres voltam para a tela.
- **Funciona sem chave.** Sem IA conectada, o assistente cai num modo simples por regras que entende valores por extenso ("cinquenta reais e noventa centavos", "mil e duzentos", "2k"), datas relativas ("sexta passada", "dia 10", "12/09"), parcelamentos, vários itens numa frase e "apaga o último", e também aprende com o histórico de categorias. O app nunca fica sem chat.
- **Sincronização idempotente.** Cada id de transação do banco fica numa tabela de referências (`bank_refs`) que pode apontar vários ids para o mesmo lançamento, porque o banco troca o id quando a compra sai de pendente. Antes de criar, o servidor procura um lançamento do mesmo tipo e valor até 3 dias de distância feito à mão (conciliação). Apagar um lançamento importado deixa a referência sem alvo, então ele não volta na sincronização seguinte.
- **MCP sem sessão, com as mesmas ferramentas.** O endpoint `/mcp` usa o transporte Streamable HTTP do SDK oficial em modo sem sessão: cada requisição autentica a chave, monta um servidor com as ferramentas do assistente e as instruções do usuário (categorias, hábitos e calendário) e responde em JSON. Nenhuma IA é chamada pelo servidor; quem conversa é o Claude da pessoa. A chave pode vir no cabeçalho `Authorization` ou no caminho (`/mcp/<chave>`), e nesse caso aparece mascarada no log.
- **Chave de menor privilégio.** As chaves (`saldo_…`) são guardadas só como hash SHA-256, aparecem uma única vez e têm um escopo: a da tarefa agendada só é aceita em `POST /api/sync/bank` e `GET /api/sync/status`, a do conector só em `/mcp` e a das notificações só em `GET /api/notifications`. Qualquer outra rota responde 403.
- **Limite de uso.** Cada usuário tem um teto de mensagens por hora (`ASSISTANT_HOURLY_LIMIT`), que protege o servidor e a conta de IA dele contra laços.
- **Aviso de meta que não se repete.** A faixa de cada meta (0, 80 ou 100%) é calculada na hora a partir dos lançamentos, e os avisos já dados ficam numa tabela (`budget_alerts`) por categoria, mês e faixa. Assim o aviso aparece uma única vez, não importa por onde o gasto entrou (inclusive pela sincronização com o banco, com o app fechado), e mudar a meta recomeça a contagem.
- **Importação idempotente com prévia.** O CSV é validado linha a linha antes de gravar, e lançamentos idênticos são pulados. Dá para importar o mesmo mês duas vezes sem bagunçar nada.

## Rodando localmente

Precisa do Node.js 20 ou mais novo.

```bash
git clone https://github.com/AlanFMF/Financeiro.git
cd Financeiro
npm install
npm run dev
```

Abra `http://localhost:5173`. A API sobe em `http://localhost:3333` com um banco PGlite salvo em `api/.data/`.

**Ligando a IA do assistente:** no app, vá em **Ajustes, Assistente de IA**, escolha a IA e cole a sua chave:

| IA | Onde criar a chave | Modelo padrão | Custo |
| --- | --- | --- | --- |
| Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | `gemini-3.8-flash` | Tem cota gratuita (no plano gratuito o Google pode usar as conversas para melhorar os produtos) |
| Claude | [Console da Anthropic](https://platform.claude.com) | `claude-haiku-5-5` | Por uso, à parte da assinatura do Claude |
| ChatGPT | [Plataforma da OpenAI](https://platform.openai.com/api-keys) | `gpt-6-luna` | Por uso; a assinatura do ChatGPT não inclui a API |

Para usar um PostgreSQL de verdade: `docker compose up -d` e rode com `DATABASE_URL=postgres://saldo:saldo@localhost:5432/saldo npm run dev`.

Para abrir no celular na mesma rede Wi-Fi, use o endereço `Network` que o Vite mostra no terminal.

```bash
npm test          # testes da API e do app
npm run e2e -w web  # ponta a ponta com Playwright (sobe a API e o app sozinho)
npm run typecheck # tipos da API e do front
npm run build     # build de produção
```

## Publicando de graça

1. **Banco no [Neon](https://neon.tech):** crie um projeto e copie a connection string (`postgres://...?sslmode=require`).
2. **API no [Render](https://render.com):** *New, Blueprint*, aponte para este repositório (ele lê o `render.yaml`). Preencha `DATABASE_URL` com a do Neon e `CORS_ORIGIN` com o endereço da Vercel. `JWT_SECRET` e `AI_KEY_SECRET` são gerados sozinhos. As migrações rodam sozinhas ao iniciar.
3. **Front no GitHub Pages:** o mesmo workflow que monta o APK publica a versão web em `alanfmf.github.io/Financeiro/app/` (build com `VITE_BASE=/Financeiro/app/`; o `404.html` do site é o próprio app, para as rotas internas funcionarem ao recarregar). Quem preferir a Vercel pode importar o repositório com *Root Directory* `web` e `VITE_API_URL` apontando para a API.
4. No computador ou no iPhone, abra a versão web e instale pelo menu do navegador (*Instalar app* no Chrome; *Compartilhar, Adicionar à Tela de Início* no Safari).

> No plano gratuito do Render a API dorme depois de 15 minutos parada, então o primeiro acesso do dia pode levar uns 50 segundos.

## APK para Android

O workflow `.github/workflows/android.yml` monta o APK com Capacitor a cada envio para a `main` e publica no GitHub Pages, junto com uma página de download:

**[alanfmf.github.io/Financeiro](https://alanfmf.github.io/Financeiro/)** (o arquivo direto fica em `alanfmf.github.io/Financeiro/saldo.apk`)

1. Na primeira vez, em *Settings, Pages*, escolha *Source: GitHub Actions*.
2. O APK já sai apontando para a API em `https://saldo-api-g1ae.onrender.com`. Para usar outro servidor, crie `SALDO_API_URL` em *Settings, Secrets and variables, Actions, Variables*; dentro do app também dá para trocar em *Servidor, Alterar*, na tela de entrada.
3. O workflow roda sozinho a cada push, ou em *Actions, APK Android, Run workflow*.
4. No celular, abra o link, toque em *Baixar para Android* e permita instalar apps dessa fonte quando o Android pedir.

Todo APK sai assinado com a mesma chave de depuração (`web/android/app/saldo-debug.keystore`), então as versões novas instalam por cima da anterior. Para publicar na Play Store, gere uma chave própria e cadastre os segredos `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` e `ANDROID_KEY_PASSWORD`: o workflow passa a usá-la sozinho.

Para gerar no próprio PC (precisa do Android Studio): `npm run build -w web`, depois `npx cap sync android` e `npx cap open android` dentro de `web/`.

## Trazendo a planilha do Google Sheets

Em cada aba de mês: *Arquivo, Fazer download, Valores separados por vírgula (.csv)*. No Saldo, vá em **Importar**, escolha o arquivo, confira a prévia e confirme. Valores como `1227.76`, `1.227,76` e `R$ 150,00` são entendidos; linhas de título e de total são ignoradas.

## API

Todas as rotas, exceto as de autenticação e `/api/health`, pedem `Authorization: Bearer <token>`. A documentação navegável (OpenAPI 3.1) fica em [`/docs`](https://saldo-api-g1ae.onrender.com/docs), e um teste garante que toda rota está documentada.

| Método | Rota | Para quê |
| --- | --- | --- |
| POST | `/api/auth/register`, `/api/auth/login` | Criar conta e entrar |
| POST | `/api/auth/demo` | Conta temporária com dados fictícios |
| GET | `/api/auth/me` | Usuário atual |
| GET, POST, PATCH, DELETE | `/api/categories` | Categorias (excluir só sem lançamentos; senão, arquivar) |
| GET, POST, PUT, DELETE | `/api/transactions` | Lançamentos, com filtros `month`, `categoryId` e `q` |
| POST | `/api/transactions/copy-fixed` | Copia os fixos de um mês para outro, avançando parcelas |
| GET, POST | `/api/transactions/review`, `/review/confirm`, `/review/:id` | Importados a conferir: listar, confirmar e trocar a categoria (os iguais vão junto) |
| GET | `/api/summary?month=AAAA-MM` | Totais, comparação com o mês anterior, total por categoria e previsão do fim do mês |
| GET | `/api/summary/history?month=AAAA-MM&months=6` | Série mensal de entradas e saídas |
| GET | `/api/budgets?month=AAAA-MM` | Metas do mês: limite, gasto, quanto resta e faixa (0, 80 ou 100) |
| PUT | `/api/budgets/:categoryId` | Define (`budgetCents`) ou remove (`null`) a meta de uma categoria de saída |
| POST | `/api/budgets/alerts` | Avisos de 80% e 100% ainda não mostrados no mês (cada um sai uma vez) |
| POST | `/api/import/csv` | Prévia (`dryRun: true`) ou importação do CSV |
| GET | `/api/export.csv?year=AAAA` | CSV no formato da planilha |
| POST | `/api/assistant/chat` | Mensagem para o assistente; devolve a resposta, os lançamentos criados, corrigidos e excluídos e os avisos de meta |
| GET | `/api/assistant/status` | Se o assistente está com IA (e qual) ou no modo simples |
| GET, POST, DELETE | `/api/tokens` | Chaves de acesso (`scope`: `sync` para a tarefa do banco, `mcp` para o conector do Claude) |
| POST | `/api/sync/bank` | Recebe transações do banco (com a chave de sincronização) |
| GET | `/api/sync/status` | Última sincronização |
| GET | `/api/notifications` | Notificações do celular (metas e importações novas), com a chave de escopo `notify`; cada uma sai uma vez |
| POST | `/mcp` | Conector do Claude (MCP, Streamable HTTP), com a chave de escopo `mcp` |
| GET, PUT, DELETE | `/api/assistant/settings` | Conectar, trocar ou desconectar a IA do usuário (a chave nunca é devolvida) |

## Próximos passos

- Importação de OFX do banco.
- Sincronização offline de lançamentos feitos sem internet.

## Licença

MIT. Feito por [Alan Fabrício de Morais Filho](https://www.linkedin.com/in/alanfmf).
