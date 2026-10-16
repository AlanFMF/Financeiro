// Lê api/.env se existir (Node 20.12+). Em produção as variáveis vêm do painel do Render.
try {
  process.loadEnvFile('.env');
} catch {
  /* sem .env, segue com as variáveis do ambiente */
}

import { createPgDb, createPgliteDb, migrate } from './db.js';
import { buildApp } from './server.js';

const port = Number(process.env.PORT ?? 3333);
const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-troque-em-producao';
// O app Android (Capacitor) chama a API a partir de https://localhost; ele entra sempre na lista.
const corsOrigin = process.env.CORS_ORIGIN
  ? [...process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean), 'https://localhost', 'capacitor://localhost']
  : undefined;

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('Defina JWT_SECRET em produção.');
  process.exit(1);
}

// Sem DATABASE_URL, roda com PGlite (Postgres embutido) salvo em ./.data — não precisa instalar nada.
const db = databaseUrl ? createPgDb(databaseUrl) : await createPgliteDb(process.env.PGLITE_DIR ?? '.data/pglite');
const applied = await migrate(db);

const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Number(v) : fallback);

if (process.env.NODE_ENV === 'production' && !process.env.AI_KEY_SECRET) {
  console.warn('AI_KEY_SECRET não definido: as chaves de IA dos usuários serão criptografadas com uma chave derivada do JWT_SECRET.');
}

const app = await buildApp({
  db,
  jwtSecret,
  aiKeySecret: process.env.AI_KEY_SECRET,
  corsOrigin: corsOrigin ?? true,
  logger: true,
  assistant: {
    timeZone: process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
    hourlyLimit: num(process.env.ASSISTANT_HOURLY_LIMIT, 60)
  }
});
if (applied.length) app.log.info({ applied }, 'migrações aplicadas');
app.log.info(databaseUrl ? 'banco: PostgreSQL' : 'banco: PGlite local (.data/pglite)');

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
