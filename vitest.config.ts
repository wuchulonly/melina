import { defineConfig } from 'vitest/config';

// unit 不碰外部依赖，pnpm check 只跑它；integration 要 git、Podman 或模型 key
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 600_000,
        },
      },
    ],
  },
});
