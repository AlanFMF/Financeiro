import { readdir, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

/**
 * Interface mínima de banco usada pela API. Duas implementações:
 * - PostgreSQL real (produção, via DATABASE_URL)
 * - PGlite (Postgres compilado para WASM) para rodar local e nos testes sem instalar nada
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function fromPgClient(client: pg.PoolClient): Db {
  return {
    query: async (sql, params) => client.query(sql, params as unknown[]) as never,
    exec: async (sql) => {
      await client.query(sql);
    },
    transaction: async (fn) => fn(fromPgClient(client)),
    close: async () => {}
  };
}

export function createPgDb(connectionString: string): Db {
  const ssl = /sslmode=require|neon\.tech|render\.com/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
  const pool = new pg.Pool({ connectionString, ssl, max: 5 });
  return {
    query: async (sql, params) => pool.query(sql, params as unknown[]) as never,
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(fromPgClient(client));
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

type PGliteTx = Parameters<Parameters<PGlite['transaction']>[0]>[0];

function fromPgliteTx(tx: PGliteTx): Db {
  return {
    query: async (sql, params) => tx.query(sql, params as unknown[]) as never,
    exec: async (sql) => {
      await tx.exec(sql);
    },
    transaction: async (fn) => fn(fromPgliteTx(tx)),
    close: async () => {}
  };
}

/** Sem `dataDir` (ou com "memory://"), o banco fica só na memória: usado nos testes. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const inMemory = !dataDir || dataDir.startsWith('memory://');
  if (!inMemory) await mkdir(dataDir, { recursive: true });
  const lite = new PGlite(inMemory ? undefined : dataDir);
  await lite.waitReady;
  return {
    query: async (sql, params) => lite.query(sql, params as unknown[]) as never,
    exec: async (sql) => {
      await lite.exec(sql);
    },
    transaction: (fn) => lite.transaction((tx) => fn(fromPgliteTx(tx))),
    close: () => lite.close()
  };
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Aplica, em ordem, os arquivos .sql de /migrations que ainda não rodaram. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name)
  );
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
