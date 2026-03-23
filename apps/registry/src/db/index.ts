import { createDb } from '@imajin/db';
import * as schema from './schema';
import * as relaySchema from './relay-schema';

export const db = createDb({ ...schema, ...relaySchema });
export * from './schema';
export * from './relay-schema';
