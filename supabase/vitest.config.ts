import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 60_000,
    env: { NODE_NO_WARNINGS: '1', TZ: 'America/Sao_Paulo' },
  },
});
