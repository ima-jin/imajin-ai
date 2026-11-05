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
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'database',
      include: databaseTests,
      pool: 'forks',
      // Vitest 2 schedules singleFork projects after ordinary fork work,
      // recycles workers, then runs this project's files in one fork.
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 15_000,
      hookTimeout: 30_000,
    },
  },
]);
