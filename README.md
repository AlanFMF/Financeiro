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
<img src="docs/desktop-mes.png" width="760" alt="Tela do mês no computador, com histórico de seis meses e lista de lançamentos">

## O que ele faz

- **Saldo do mês em destaque**, com uma régua que mostra quanto do que entrou já saiu e a comparação com o mês anterior.
- **Lançamento rápido pelo celular**: teclado numérico, categorias em botões, data já preenchida. O atalho do ícone instalado abre direto o formulário.
- **Gastos fixos e parcelas**: marque um lançamento como fixo e copie todos para o mês seguinte com um toque. Descrições como `Financiamento (10/48)` avançam sozinhas para `(11/48)`, e a parcela final não é copiada.
- **Para onde foi**: total e percentual por categoria, histórico de seis meses e busca com filtro.
- **Importação da planilha**: CSV com Data, Categoria, Descrição, Entrada e Saída (ou extrato com coluna Valor). Mostra uma prévia, aponta linhas com erro, cria categorias novas e não duplica o que já foi importado.
- **Exportação** no mesmo formato da planilha.
- **PWA instalável**, funciona offline para abrir o app, modo escuro automático e layout pensado primeiro para o celular.
- **Demonstração pública** sem expor dados reais: cada visitante ganha uma conta temporária que é apagada em 24 horas.

## Stack

| Camada | Tecnologias |
| --- | --- |
| API | Node.js 22, TypeScript, Fastify 5, Zod, JWT, bcrypt, rate limit |
| Banco | PostgreSQL 16 com SQL puro e migrações versionadas. Em desenvolvimento e nos testes roda em [PGlite](https://pglite.dev) (Postgres em WASM), sem instalar nada |
| Front | React 18, TypeScript, Vite, TanStack Query, React Router, vite-plugin-pwa |
| Qualidade | Vitest (31 testes de API e de regras), GitHub Actions com PostgreSQL 16 real |
| Deploy | Vercel (front), Render (API), Neon (PostgreSQL), todos no plano gratuito |

## Decisões que valem a pena explicar

- **Dinheiro em centavos inteiros.** Nada de `float` para valores: `R$ 1.227,76` vira `122776`. Somas e comparações ficam exatas.
- **SQL escrito à mão em vez de ORM.** Os relatórios usam `sum(...) filter (where ...)`, `generate_series` para meses sem lançamento e `date_trunc`. Fica legível e mostra o que o banco está fazendo.
- **Uma interface `Db`, dois motores.** A mesma API roda em PostgreSQL (produção) ou PGlite (local e testes). Quem clona o repositório roda `npm run dev` e já tem um Postgres funcionando.
- **Isolamento por usuário em toda consulta.** Todo `select`, `update` e `delete` filtra por `user_id`, e há teste garantindo que um usuário não lê nem apaga dado de outro, nem usa a categoria de outro.
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

Para usar um PostgreSQL de verdade: `docker compose up -d` e rode com `DATABASE_URL=postgres://saldo:saldo@localhost:5432/saldo npm run dev`.

Para abrir no celular na mesma rede Wi-Fi, use o endereço `Network` que o Vite mostra no terminal.

```bash
npm test          # testes da API
npm run typecheck # tipos da API e do front
npm run build     # build de produção
```

## Publicando de graça

1. **Banco no [Neon](https://neon.tech):** crie um projeto e copie a connection string (`postgres://...?sslmode=require`).
2. **API no [Render](https://render.com):** *New, Blueprint*, aponte para este repositório (ele lê o `render.yaml`). Preencha `DATABASE_URL` com a do Neon e `CORS_ORIGIN` com o endereço da Vercel. As migrações rodam sozinhas ao iniciar.
3. **Front na [Vercel](https://vercel.com):** importe o repositório com *Root Directory* `web` e a variável `VITE_API_URL` apontando para a API do Render.
4. No celular, abra o endereço da Vercel. No Android: menu do Chrome, *Instalar app*. No iPhone: Safari, *Compartilhar*, *Adicionar à Tela de Início*.

> No plano gratuito do Render a API dorme depois de 15 minutos parada, então o primeiro acesso do dia pode levar uns 50 segundos.

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

## Próximos passos

- Metas e limites por categoria, com aviso quando passar de 80%.
- Importação de OFX do banco.
- Sincronização offline de lançamentos feitos sem internet.

## Licença

MIT. Feito por [Alan Fabrício de Morais Filho](https://www.linkedin.com/in/alanfmf).
