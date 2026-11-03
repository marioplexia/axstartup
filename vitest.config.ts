import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['tests/helpers/globalSetup.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'development', /* los tokens de desarrollo solo existen con NODE_ENV=development; tests/auth.test.ts prueba el rechazo en otros entornos */ JWT_SECRET: 'test-secret-no-usar-en-produccion', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://axai:axai@localhost:5432/axai_test', LLM_MODE: 'mock' },
    testTimeout: 20000,
  },
});
