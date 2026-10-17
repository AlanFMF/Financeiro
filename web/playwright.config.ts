import { defineConfig, devices } from '@playwright/test';

/**
 * Testes de ponta a ponta: sobem a API (com PGlite em memória) e o app, e usam um celular emulado.
 * Localmente, se a API e o app já estiverem rodando, eles são reaproveitados.
 * PW_CHROMIUM aponta para um Chromium já instalado, quando a versão baixada pelo Playwright não estiver disponível.
 */
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  retries: CI ? 1 : 0,
  timeout: 45_000,
  reporter: CI ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: 'http://localhost:5173',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}
  },
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: '../api',
      url: 'http://localhost:3333/api/health',
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: { PGLITE_DIR: 'memory://', JWT_SECRET: 'e2e', PORT: '3333' }
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
      timeout: 60_000
    }
  ]
});
