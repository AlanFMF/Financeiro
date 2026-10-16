import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Saldo — controle financeiro',
        short_name: 'Saldo',
        description: 'Entradas, saídas e saldo do mês no seu bolso.',
        lang: 'pt-BR',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#EDE6D6',
        theme_color: '#1B3A4B',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ],
        shortcuts: [{ name: 'Novo lançamento', url: '/?novo=1', icons: [{ src: 'icon-192.png', sizes: '192x192' }] }]
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}']
      }
    })
  ],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': 'http://localhost:3333' }
  }
});
