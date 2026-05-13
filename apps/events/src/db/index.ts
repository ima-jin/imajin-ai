import { createDb } from '@imajin/db';
import * as schema from './schema';

export const db = createDb(schema);
export * from './schema';

// Re-export pledges for convenience
export { schema };
