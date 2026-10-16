import { createPgDb, createPgliteDb, migrate } from './db.js';
import { buildApp } from './server.js';

const port = Number(process.env.PORT ?? 3333);
const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-troque-em-producao';
const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim());

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('Defina JWT_SECRET em produção.');
  process.exit(1);
}

// Sem DATABASE_URL, roda com PGlite (Postgres embutido) salvo em ./.data — não precisa instalar nada.
const db = databaseUrl ? createPgDb(databaseUrl) : await createPgliteDb(process.env.PGLITE_DIR ?? '.data/pglite');
const applied = await migrate(db);

const app = await buildApp({ db, jwtSecret, corsOrigin: corsOrigin ?? true, logger: true });
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
