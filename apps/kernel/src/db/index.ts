import { createDb, getClient } from '@imajin/db';

import * as authSchema from './schemas/auth';
import * as oauthSchema from './schemas/oauth';
import * as paySchema from './schemas/pay';
import * as profileSchema from './schemas/profile';
import * as registrySchema from './schemas/registry';
import * as connectionsSchema from './schemas/connections';
import * as chatSchema from './schemas/chat';
import * as chatV2Schema from './schemas/chat-v2';
import * as mediaSchema from './schemas/media';
import * as notifySchema from './schemas/notify';
import * as wwwSchema from './schemas/www';
import * as busSchema from './schemas/bus';
import * as calendarSchema from './schemas/calendar';
import * as matchSchema from './schemas/match';

const schema = {
  ...authSchema,
  ...oauthSchema,
  ...paySchema,
  ...profileSchema,
  ...registrySchema,
  ...connectionsSchema,
  ...chatSchema,
  ...chatV2Schema,
  ...mediaSchema,
  ...notifySchema,
  ...wwwSchema,
  ...busSchema,
  ...calendarSchema,
  ...matchSchema,
};

export const db = createDb(schema);

export { getClient };

export * from './schemas/auth';
export * from './schemas/oauth';
export * from './schemas/pay';
export * from './schemas/profile';
export * from './schemas/registry';
export * from './schemas/connections';
export * from './schemas/chat';
export * from './schemas/media';
export * from './schemas/notify';
export * from './schemas/www';
export * from './schemas/bus';
export * from './schemas/calendar';
export * from './schemas/match';

// Aliases for backward-compatible imports
export { podsInConnections as pods } from "./schemas/connections";
export { podMembersInConnections as podMembers } from "./schemas/connections";
export { invitesInConnections as invites } from "./schemas/connections";
export { podKeysInConnections as podKeys } from "./schemas/connections";
export { podMemberKeysInConnections as podMemberKeys } from "./schemas/connections";
export { podLinksInConnections as podLinks } from "./schemas/connections";
export * from './schemas/chat-v2';
