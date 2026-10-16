# Saldo

**[English version](README.en.md)**

Controle financeiro pessoal que funciona no computador e se instala no celular como app. Você lança entradas e saídas em poucos toques, vê o saldo do mês e descobre para onde o dinheiro está indo.

Nasceu de uma planilha real do Google Sheets que eu uso para organizar as finanças de casa. O Saldo importa essa planilha, mantém as mesmas categorias e exporta de volta no mesmo formato.

> **Demonstração:** `https://SEU-APP.vercel.app` (clique em *Abrir a demonstração*: cria uma conta temporária com quatro meses de dados fictícios).

<p>
  <img src="docs/mobile-mes.png" width="240" alt="Tela do mês no celular, com saldo, régua de gastos e categorias">
  <img src="docs/mobile-lancamento.png" width="240" alt="Formulário de novo lançamento com valor, categoria e data">
  <img src="docs/mobile-escuro.png" width="240" alt="Tela do mês no modo escuro">
</p>
<img src="docs/desktop-assistente.png" width="760" alt="Tela do mês no computador com o assistente aberto no canto, depois de lançar um freela e a conta de internet">

<p>
  <img src="docs/mobile-assistente.png" width="240" alt="Assistente no celular lançando mercado e gasolina a partir de uma frase">
</p>

## O que ele faz

- **Assistente com IA no canto da tela**: escreva ou fale "gastei 45,90 no mercado e 120 de gasolina ontem" e ele lança os dois na categoria certa, com a data certa. Cada lançamento aparece no chat com **Editar** e **Desfazer**. Entende frases como "mercado deu 230, mas 40 foi ração" (separa em dois), "tênis de 600 em 6x no cartão" (lança a parcela 1/6), "jantar de 120 dividido por 3", e correções como "na verdade a gasolina foi 160" ou "apaga o do uber". Também responde perguntas como "quanto gastei com alimentação este mês?".
- **Saldo do mês em destaque**, com uma régua que mostra quanto do que entrou já saiu e a comparação com o mês anterior.
- **Lançamento rápido pelo celular**: teclado numérico, categorias em botões, data já preenchida. O atalho do ícone instalado abre direto o formulário.
- **Gastos fixos e parcelas**: marque um lançamento como fixo e copie todos para o mês seguinte com um toque. Descrições como `Financiamento (10/48)` avançam sozinhas para `(11/48)`, e a parcela final não é copiada.
- **Para onde foi**: total e percentual por categoria, histórico de seis meses e busca com filtro.
- **Importação da planilha**: CSV com Data, Categoria, Descrição, Entrada e Saída (ou extrato com coluna Valor). Mostra uma prévia, aponta linhas com erro, cria categorias novas e não duplica o que já foi importado.
- **Exportação** no mesmo formato da planilha.
- **Cada um usa a própria IA**: em Ajustes, a pessoa escolhe Claude, ChatGPT ou Gemini e cola a chave dela. A chave é testada antes de ser salva, fica criptografada no servidor e nunca volta para o aparelho. Sem chave, o assistente funciona no modo simples.
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
| Qualidade | Vitest (84 testes de API, interpretador de frases, adaptadores das IAs e assistente com IA simulada), GitHub Actions com PostgreSQL 16 real |
| Deploy | Vercel (front), Render (API), Neon (PostgreSQL), todos no plano gratuito |

## Decisões que valem a pena explicar

- **Dinheiro em centavos inteiros.** Nada de `float` para valores: `R$ 1.227,76` vira `122776`. Somas e comparações ficam exatas.
- **SQL escrito à mão em vez de ORM.** Os relatórios usam `sum(...) filter (where ...)`, `generate_series` para meses sem lançamento e `date_trunc`. Fica legível e mostra o que o banco está fazendo.
- **Uma interface `Db`, dois motores.** A mesma API roda em PostgreSQL (produção) ou PGlite (local e testes). Quem clona o repositório roda `npm run dev` e já tem um Postgres funcionando.
- **Isolamento por usuário em toda consulta.** Todo `select`, `update` e `delete` filtra por `user_id`, e há teste garantindo que um usuário não lê nem apaga dado de outro, nem usa a categoria de outro.
- **A IA não toca no banco.** O modelo só pode chamar cinco ferramentas (`registrar_lancamentos`, `corrigir_lancamento`, `excluir_lancamento`, `consultar_lancamentos`, `resumo_do_mes`). Quem valida valor, data e categoria e escreve no PostgreSQL é o código da API, sempre com o `user_id` de quem está logado. Ele recebe no prompt a data de hoje e as categorias do usuário, e o laço de ferramentas tem limite de rodadas.
- **A IA conhece o usuário.** O prompt leva os hábitos de categoria dele (a "Padaria do Zé" que ele sempre lança em Lazer), os últimos lançamentos com id (para corrigir e apagar o certo) e um calendário dos últimos dez dias, para "sexta passada" nunca virar a data errada.
- **Três IAs, uma interface.** Claude, ChatGPT e Gemini falam formatos diferentes de chamada de ferramentas. Cada um tem um adaptador pequeno que traduz para a mesma interface (`start` e `continue`), então o laço do assistente não sabe com qual IA está falando. No Gemini, o conteúdo do modelo volta intacto a cada rodada para preservar as *thought signatures*; no ChatGPT, as rodadas são encadeadas por `previous_response_id`.
- **Chave do usuário guardada com cuidado.** AES-256-GCM com um segredo do servidor (`AI_KEY_SECRET`); a chave é validada listando os modelos do provedor (não gasta tokens) e só os quatro últimos caracteres voltam para a tela.
- **Funciona sem chave.** Sem IA conectada, o assistente cai num modo simples por regras que entende valores por extenso ("cinquenta reais e noventa centavos", "mil e duzentos", "2k"), datas relativas ("sexta passada", "dia 10", "12/09"), parcelamentos, vários itens numa frase e "apaga o último", e também aprende com o histórico de categorias. O app nunca fica sem chat.
- **Limite de uso.** Cada usuário tem um teto de mensagens por hora (`ASSISTANT_HOURLY_LIMIT`), que protege o servidor e a conta de IA dele contra laços.
- **Importação idempotente com prévia.** O CSV é validado linha a linha antes de gravar, e lançamentos idênticos são pulados. Dá para importar o mesmo mês duas vezes sem bagunçar nada.

## Rodando localmente

Precisa do Node.js 20 ou mais novo.

```bash
git clone https://github.com/AlanFMF/saldo.git
cd saldo
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
npm test          # testes da API
npm run typecheck # tipos da API e do front
npm run build     # build de produção
```

## Publicando de graça

1. **Banco no [Neon](https://neon.tech):** crie um projeto e copie a connection string (`postgres://...?sslmode=require`).
2. **API no [Render](https://render.com):** *New, Blueprint*, aponte para este repositório (ele lê o `render.yaml`). Preencha `DATABASE_URL` com a do Neon e `CORS_ORIGIN` com o endereço da Vercel. `JWT_SECRET` e `AI_KEY_SECRET` são gerados sozinhos. As migrações rodam sozinhas ao iniciar.
3. **Front na [Vercel](https://vercel.com):** importe o repositório com *Root Directory* `web` e a variável `VITE_API_URL` apontando para a API do Render.
4. No celular, abra o endereço da Vercel. No Android: menu do Chrome, *Instalar app*. No iPhone: Safari, *Compartilhar*, *Adicionar à Tela de Início*.

> No plano gratuito do Render a API dorme depois de 15 minutos parada, então o primeiro acesso do dia pode levar uns 50 segundos.

## APK para Android

O workflow `.github/workflows/android.yml` monta o APK com Capacitor a cada envio para a `main` e publica em **Releases**, sempre no mesmo endereço:

```
https://github.com/AlanFMF/saldo/releases/download/apk/saldo.apk
```

1. No GitHub, em *Settings, Secrets and variables, Actions, Variables*, crie `SALDO_API_URL` com o endereço da API no Render (ex.: `https://saldo-api.onrender.com`). Sem ela, o app pede o endereço do servidor na tela de entrada.
2. Rode o workflow (ele roda sozinho a cada push, ou em *Actions, APK Android, Run workflow*).
3. No celular, abra o link acima, baixe `saldo.apk` e permita instalar apps dessa fonte quando o Android pedir.

Todo APK sai assinado com a mesma chave de depuração (`web/android/app/saldo-debug.keystore`), então as versões novas instalam por cima da anterior. Para publicar na Play Store, gere uma chave própria e cadastre os segredos `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` e `ANDROID_KEY_PASSWORD`: o workflow passa a usá-la sozinho.

Para gerar no próprio PC (precisa do Android Studio): `npm run build -w web`, depois `npx cap sync android` e `npx cap open android` dentro de `web/`.

## Trazendo a planilha do Google Sheets

Em cada aba de mês: *Arquivo, Fazer download, Valores separados por vírgula (.csv)*. No Saldo, vá em **Importar**, escolha o arquivo, confira a prévia e confirme. Valores como `1227.76`, `1.227,76` e `R$ 150,00` são entendidos; linhas de título e de total são ignoradas.

## API

Todas as rotas, exceto as de autenticação e `/api/health`, pedem `Authorization: Bearer <token>`.

| Método | Rota | Para quê |
| --- | --- | --- |
| POST | `/api/auth/register`, `/api/auth/login` | Criar conta e entrar |
| POST | `/api/auth/demo` | Conta temporária com dados fictícios |
| GET | `/api/auth/me` | Usuário atual |
| GET, POST, PATCH, DELETE | `/api/categories` | Categorias (excluir só sem lançamentos; senão, arquivar) |
| GET, POST, PUT, DELETE | `/api/transactions` | Lançamentos, com filtros `month`, `categoryId` e `q` |
| POST | `/api/transactions/copy-fixed` | Copia os fixos de um mês para outro, avançando parcelas |
| GET | `/api/summary?month=AAAA-MM` | Totais, comparação com o mês anterior e total por categoria |
| GET | `/api/summary/history?month=AAAA-MM&months=6` | Série mensal de entradas e saídas |
| POST | `/api/import/csv` | Prévia (`dryRun: true`) ou importação do CSV |
| GET | `/api/export.csv?year=AAAA` | CSV no formato da planilha |
| POST | `/api/assistant/chat` | Mensagem para o assistente; devolve a resposta e os lançamentos criados, corrigidos e excluídos |
| GET | `/api/assistant/status` | Se o assistente está com IA (e qual) ou no modo simples |
| GET, PUT, DELETE | `/api/assistant/settings` | Conectar, trocar ou desconectar a IA do usuário (a chave nunca é devolvida) |

## Próximos passos

- Metas e limites por categoria, com aviso quando passar de 80%.
- Importação de OFX do banco.
- Sincronização offline de lançamentos feitos sem internet.

## Licença

MIT. Feito por [Alan Fabrício de Morais Filho](https://www.linkedin.com/in/alanfmf).
