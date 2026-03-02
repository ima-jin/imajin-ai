import { createDb } from '@imajin/db';
import * as trustGraphSchema from '@imajin/trust-graph';
import * as profileSchema from '../../../profile/src/db/schema';

const schema = { ...trustGraphSchema, ...profileSchema };

export const db = createDb(schema);
export * from '@imajin/trust-graph';
export { profiles } from '../../../profile/src/db/schema';
