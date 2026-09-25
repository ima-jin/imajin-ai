export { createDb, getClient } from './client';
export type { AnyDatabase, PostgresJsDatabase } from './client';

// Per-app migration status (#2384) — see migration-status.ts for the full
// rationale (each app is master of its own schema; no cross-DB reads).
export {
  createPostgresMigrationsQuerier,
  defaultMigrationsDir,
  getMigrationStatus,
  listMigrationFilenames,
} from './migration-status';
export type { MigrationStatus, MigrationStatusQuerier } from './migration-status';

// Shared /api/health route factory (#2384) — see health-route.ts for the
// full rationale (one implementation shared by every schema-owning app).
export { checkAppMigrations, createAppHealthHandler, hasPendingMigrations } from './health-route';
export type { AppHealthHandlerOptions } from './health-route';
