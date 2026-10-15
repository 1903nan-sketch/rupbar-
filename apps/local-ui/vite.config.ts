import legacy from '@vitejs/plugin-legacy';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Em desenvolvimento, a API do servidor local roda em :7420.
export default defineConfig({
  plugins: [
    react(),
    // TV box e celulares antigos (WebView/Chrome desatualizado): versão
    // alternativa com polyfills, carregada só quando o navegador precisa.
    legacy({ targets: ['defaults', 'chrome >= 49', 'android >= 5', 'safari >= 10'], modernPolyfills: true }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7420',
      '/ws': { target: 'ws://127.0.0.1:7420', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    // Tudo empacotado localmente: a interface funciona sem internet e sem CDN.
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 900,
    sourcemap: false,
  },
});
