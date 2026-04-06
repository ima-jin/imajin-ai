import { createDb, getClient } from '@imajin/db';

import * as authSchema from './schemas/auth';
import * as paySchema from './schemas/pay';
import * as profileSchema from './schemas/profile';
import * as registrySchema from './schemas/registry';
import * as connectionsSchema from './schemas/connections';
import * as chatSchema from './schemas/chat';
import * as mediaSchema from './schemas/media';
import * as notifySchema from './schemas/notify';
import * as wwwSchema from './schemas/www';

const schema = {
  ...authSchema,
  ...paySchema,
  ...profileSchema,
  ...registrySchema,
  ...connectionsSchema,
  ...chatSchema,
  ...mediaSchema,
  ...notifySchema,
  ...wwwSchema,
};

export const db = createDb(schema);

export { getClient };

export * from './schemas/auth';
export * from './schemas/pay';
export * from './schemas/profile';
export * from './schemas/registry';
export * from './schemas/connections';
export * from './schemas/chat';
export * from './schemas/media';
export * from './schemas/notify';
export * from './schemas/www';
