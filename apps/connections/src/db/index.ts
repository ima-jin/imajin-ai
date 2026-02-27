import { createDb } from '@imajin/db';
import * as schema from '@imajin/trust-graph';

export const db = createDb(schema);
export * from '@imajin/trust-graph';
