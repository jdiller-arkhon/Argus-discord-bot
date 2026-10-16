import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against shared sources directly so no build step is needed first.
      '@arkhon/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'bots/*/test/**/*.test.ts', 'deploy/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
