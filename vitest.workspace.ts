import { configDefaults, defineWorkspace } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { databaseTestFiles } from './scripts/test-projects.mjs';
import { testInclude } from './vitest.config';

const databaseTests = databaseTestFiles(fileURLToPath(new URL('.', import.meta.url)));

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: testInclude,
      exclude: [...configDefaults.exclude, ...databaseTests],
      pool: 'forks',
      poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'database',
      include: databaseTests,
      pool: 'forks',
      poolOptions: { forks: { minForks: 1, maxForks: 1 } },
      testTimeout: 15_000,
      hookTimeout: 30_000,
    },
  },
]);
