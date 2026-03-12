import { createDb } from '@imajin/db';
import * as schema from './schema';
import * as schemaV2 from './schema-v2';

export const db = createDb({ ...schema, ...schemaV2 });
export * from './schema';
export * from './schema-v2';
