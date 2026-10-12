import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 20_000,
    // node:sqlite é experimental no Node 22 e emite aviso; silenciamos nos testes
    env: { NODE_NO_WARNINGS: '1', TZ: 'America/Sao_Paulo' },
  },
});
