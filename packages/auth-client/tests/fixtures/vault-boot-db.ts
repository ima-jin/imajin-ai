import { boot } from './vault-boot-config';

// Models a database client capturing its configuration during module evaluation.
// No database is contacted and this deliberately non-URL fixture is never usable.
export const databaseUrlAtModuleInitialization = boot.getConfig().DATABASE_URL;
