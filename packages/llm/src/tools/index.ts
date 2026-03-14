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
  // Context
  targetDid: string;
  requesterDid: string;
  trustDistance: number;
  // Optional auth for internal calls
  internalApiKey?: string;
}

export function createPresenceTools(config: ToolConfig) {
  // Always available (public data)
  const tools = {
    ...createProfileTools({ profileUrl: config.profileUrl, apiKey: config.internalApiKey }),
    ...createEventTools({ eventsUrl: config.eventsUrl, apiKey: config.internalApiKey }),
  };

  // Distance 1: social graph access
  if (config.trustDistance <= 1) {
    Object.assign(tools, createConnectionTools({ connectionsUrl: config.connectionsUrl, apiKey: config.internalApiKey }));
    Object.assign(tools, createAttestationTools({ authUrl: config.authUrl, apiKey: config.internalApiKey }));
    Object.assign(tools, createLearnTools({ learnUrl: config.learnUrl, apiKey: config.internalApiKey }));
  }

  // Self-query: full access
  if (config.requesterDid === config.targetDid) {
    Object.assign(tools, createPayTools({ payUrl: config.payUrl, apiKey: config.internalApiKey }));
  }

  return tools;
}
