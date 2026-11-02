import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['tests/helpers/globalSetup.ts'],
    fileParallelism: false,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://axai:axai@localhost:5432/axai_test', LLM_MODE: 'mock' },
    testTimeout: 20000,
  },
});
