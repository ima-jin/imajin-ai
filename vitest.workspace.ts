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
      // A distinct pool lets DB work run alongside unit forks without
      // sharing their worker queue. Keep database files serial within it.
      pool: 'threads',
      poolOptions: { threads: { singleThread: true } },
      testTimeout: 15_000,
      hookTimeout: 30_000,
    },
  },
]);
