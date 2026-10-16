import { createPgliteDb, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/server.js';

export async function setup() {
  const db: Db = await createPgliteDb();
  await migrate(db);
  const app = await buildApp({ db, jwtSecret: 'test', rateLimit: false });

  async function register(email = 'alan@example.com') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Alan', email, password: 'senha-forte-123' }
    });
    const { token } = res.json();
    const headers = { authorization: `Bearer ${token}` };
    const cats = (await app.inject({ method: 'GET', url: '/api/categories', headers })).json().categories as {
      id: number;
      name: string;
      kind: string;
    }[];
    const cat = (name: string) => cats.find((c) => c.name === name)!.id;
    return { token, headers, cat };
  }

  return {
    app,
    db,
    register,
    close: async () => {
      await app.close();
      await db.close();
    }
  };
}
