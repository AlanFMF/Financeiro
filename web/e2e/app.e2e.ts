import { expect, test, type Page } from '@playwright/test';

/** Cria uma conta nova pela tela de entrada e espera a tela do mês. */
async function signUp(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Criar conta' }).click();
  await page.locator('input[autocomplete=name]').fill('Pessoa de Teste');
  await page.locator('input[type=email]').fill(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@teste.com`);
  await page.locator('input[type=password]').fill('senha-forte-123');
  await page.locator('button.btn.primary.block').click();
  await expect(page.locator('.month-title')).toBeVisible();
}

async function openChat(page: Page) {
  await page.getByRole('button', { name: 'Abrir assistente' }).click();
  await expect(page.locator('.chat-compose textarea')).toBeVisible();
}

async function say(page: Page, text: string) {
  await page.locator('.chat-compose textarea').fill(text);
  await page.keyboard.press('Enter');
}

test('a demonstração abre com saldo, metas e previsão', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir a demonstração' }).click();
  await expect(page.locator('.hero-value')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Metas do mês' })).toBeVisible();
  await expect(page.locator('.forecast')).toContainText('Previsão para');
});

test('lança pelo formulário e o saldo do mês muda', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'Novo lançamento' }).first().click();
  await page.locator('.amount-field input').fill('45,90');
  await page.getByRole('button', { name: 'Alimentação' }).click();
  await page.getByPlaceholder('Ex.: Mercado do mês').fill('Mercado');
  await page.getByRole('button', { name: 'Lançar saída' }).click();

  await expect(page.locator('.toast')).toHaveText('Saída lançada');
  await expect(page.locator('.hero-value')).toContainText('45,90');
  await expect(page.locator('.tx-desc', { hasText: 'Mercado' }).first()).toBeVisible();
});

test('o assistente lança, desfaz e responde sobre a meta', async ({ page }) => {
  await signUp(page);

  // Meta de Alimentação em Ajustes.
  await page.getByRole('link', { name: 'Ajustes' }).last().click();
  const meta = page.getByLabel('Alimentação', { exact: true });
  await meta.fill('100');
  await meta.press('Enter');
  await expect(page.locator('#metas .budget-status.saved')).toHaveText('Salvo');

  await page.getByRole('link', { name: 'Mês' }).last().click();
  await openChat(page);
  await say(page, 'gastei 85 no mercado e 12 de uber');

  const reply = page.locator('.bubble.assistant').last();
  await expect(reply).toContainText('Lancei R$ 85,00 em Alimentação e R$ 12,00 em Transporte');
  await expect(reply.locator('.chat-txs li')).toHaveCount(2);
  await expect(reply.locator('.budget-alert')).toContainText('85% da meta de Alimentação');

  // Desfaz o Uber.
  await reply.locator('.chat-txs li', { hasText: 'Uber' }).getByRole('button', { name: 'Desfazer' }).click();
  await expect(reply.locator('.chat-txs li', { hasText: 'Uber' })).toContainText('Desfeito');

  await say(page, 'quanto ainda posso gastar no mercado?');
  await expect(page.locator('.bubble.assistant').last()).toContainText('ainda pode gastar R$ 15,00');
});

test('importados do banco aparecem para conferir e a troca de categoria ensina o app', async ({ page }) => {
  await signUp(page);
  const jwt = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.includes('token'))?.[1]);
  const api = page.request;
  const token = (await (await api.post('/api/tokens', { headers: { authorization: `Bearer ${jwt}` }, data: { name: 'e2e', scope: 'sync' } })).json()).token;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const item = (externalId: string) => ({
    externalId,
    date: today,
    amountCents: 1900,
    kind: 'saida',
    description: 'Compra no débito|Kachin',
    bankCategory: 'Shopping'
  });
  const res = await api.post('/api/sync/bank', { headers: { authorization: `Bearer ${token}` }, data: { source: 'Nubank conta', items: [item('a'), item('b')] } });
  expect((await res.json()).created).toBe(2);

  await page.reload();
  const panel = page.locator('.review-panel');
  await expect(panel.locator('.count-badge')).toHaveText('2');
  await panel.locator('.review-select').first().selectOption({ label: 'Alimentação' });
  await expect(page.locator('.toast')).toContainText('2 lançamentos de "Kachin" foram para Alimentação');
  await expect(panel).toHaveCount(0);

  // A próxima importação já vem na categoria certa.
  await api.post('/api/sync/bank', { headers: { authorization: `Bearer ${token}` }, data: { source: 'Nubank conta', items: [item('c')] } });
  await page.reload();
  await expect(page.locator('.review-select').first()).toHaveValue(/\d+/);
  await expect(page.locator('.review-select').first().locator('option:checked')).toHaveText('Alimentação');
});

test('navega entre as abas sem perder a sessão', async ({ page }) => {
  await signUp(page);
  await page.getByRole('link', { name: 'Lançamentos' }).last().click();
  await expect(page).toHaveURL(/lancamentos/);
  await page.getByRole('link', { name: 'Mês' }).last().click();
  await expect(page.locator('.month-title')).toBeVisible();
});

test('sem internet: lança no aparelho e sobe quando a conexão volta', async ({ page, context }) => {
  await signUp(page);
  await context.setOffline(true);
  await expect(page.locator('.offline-bar')).toContainText('Sem internet');

  await page.getByRole('button', { name: 'Novo lançamento' }).first().click();
  await page.locator('.amount-field input').fill('32,50');
  await page.getByRole('button', { name: 'Transporte' }).click();
  await page.getByPlaceholder('Ex.: Mercado do mês').fill('Uber offline');
  await page.getByRole('button', { name: 'Lançar saída' }).click();

  await expect(page.locator('.toast')).toContainText('Sobe quando a internet voltar');
  const row = page.locator('.tx', { hasText: 'Uber offline' });
  await expect(row.locator('.pending-tag')).toBeVisible();
  await expect(page.locator('.hero-value')).toContainText('32,50');
  await expect(page.locator('.offline-bar')).toContainText('1 alteração esperando');

  await context.setOffline(false);
  await expect(page.locator('.toast')).toContainText('foi salva');
  await expect(page.locator('.offline-bar')).toHaveCount(0);
  await expect(page.locator('.tx', { hasText: 'Uber offline' }).locator('.pending-tag')).toHaveCount(0);

  // Está mesmo no servidor, uma vez só.
  const jwt = await page.evaluate(() => localStorage.getItem('saldo.token'));
  const res = await page.request.get('/api/transactions?q=Uber%20offline', { headers: { authorization: `Bearer ${jwt}` } });
  expect((await res.json()).transactions).toHaveLength(1);
});

test('abre sem conexão com o servidor: continua logado e mostra os últimos dados', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'Novo lançamento' }).first().click();
  await page.locator('.amount-field input').fill('12');
  await page.getByRole('button', { name: 'Alimentação' }).click();
  await page.getByPlaceholder('Ex.: Mercado do mês').fill('Pão de queijo');
  await page.getByRole('button', { name: 'Lançar saída' }).click();
  await expect(page.locator('.tx-desc', { hasText: 'Pão de queijo' })).toBeVisible();
  await page.waitForTimeout(2500); // o cache é gravado no aparelho a cada 2 s

  // Servidor inalcançável (só a API; o app em si continua carregando).
  await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.locator('.month-title')).toBeVisible();
  await expect(page.locator('.tx-desc', { hasText: 'Pão de queijo' })).toBeVisible();
  await expect(page.locator('.hero-value')).toContainText('12,00');
});

test('mudança feita fora do app (Telegram, outro aparelho) aparece sozinha na tela', async ({ page }) => {
  await signUp(page);
  await expect(page.locator('.hero-value')).toBeVisible();
  const jwt = await page.evaluate(() => localStorage.getItem('saldo.token'));
  const auth = { authorization: `Bearer ${jwt}` };
  const cats = (await (await page.request.get('/api/categories', { headers: auth })).json()).categories as { id: number; name: string }[];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  await page.waitForTimeout(1000); // conexão de avisos aberta

  // Como se fosse outro aparelho (outro x-client-id) lançando.
  await page.request.post('/api/transactions', {
    headers: { ...auth, 'x-client-id': 'outro-aparelho' },
    data: { categoryId: cats.find((c) => c.name === 'Lazer')!.id, date: today, description: 'Cinema pelo Telegram', amountCents: 3300 }
  });
  await expect(page.locator('.tx-desc', { hasText: 'Cinema pelo Telegram' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.hero-value')).toContainText('33,00');
});
