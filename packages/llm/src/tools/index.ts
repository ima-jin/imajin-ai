import { createEventTools } from './events';
import { createConnectionTools } from './connections';
import { createAttestationTools } from './attestations';
import { createProfileTools } from './profile';
import { createPayTools } from './pay';
import { createLearnTools } from './learn';

export { createEventTools } from './events';
export { createConnectionTools } from './connections';
export { createAttestationTools } from './attestations';
export { createProfileTools } from './profile';
export { createPayTools } from './pay';
export { createLearnTools } from './learn';

export interface ToolConfig {
  // Service URLs
  eventsUrl: string;
  connectionsUrl: string;
  authUrl: string;
  payUrl: string;
  profileUrl: string;
  learnUrl: string;
  // Conversation scope — every tool is bounded to these two participants
  targetDid: string;
  requesterDid: string;
  trustDistance: number;
  // Optional auth for internal calls
  internalApiKey?: string;
}

/**
 * Create trust-scoped presence tools.
 *
 * Every tool is bounded to the conversation between targetDid and requesterDid.
 * Tools can only access data belonging to these two participants.
 * Which tools are available depends on trust distance.
 */
export function createPresenceTools(config: ToolConfig) {
  const scope = {
    targetDid: config.targetDid,
    requesterDid: config.requesterDid,
  };

  // Always available (public data, still participant-scoped)
  const tools = {
    ...createProfileTools({ profileUrl: config.profileUrl, ...scope, apiKey: config.internalApiKey }),
    ...createEventTools({ eventsUrl: config.eventsUrl, ...scope, apiKey: config.internalApiKey }),
  };

  // Distance 1: social graph access
  if (config.trustDistance <= 1) {
    Object.assign(tools, createConnectionTools({ connectionsUrl: config.connectionsUrl, ...scope, apiKey: config.internalApiKey }));
    Object.assign(tools, createAttestationTools({ authUrl: config.authUrl, ...scope, apiKey: config.internalApiKey }));
    Object.assign(tools, createLearnTools({ learnUrl: config.learnUrl, ...scope, apiKey: config.internalApiKey }));
  }

  // Self-query: full access (still scoped to self)
  if (config.requesterDid === config.targetDid) {
    Object.assign(tools, createPayTools({ payUrl: config.payUrl, ...scope, apiKey: config.internalApiKey }));
  }

  return tools;
}
