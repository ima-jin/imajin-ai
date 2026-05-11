export { createSigner, getPublicKeyBytes } from './signer';
export { createIdentityChain, updateIdentityChain, verifyChain, DFOS_DID_PREFIX } from './bridge';
export type { VerifiedIdentity } from './bridge';
export { publishContentEvent, getContentEvent } from './content-publish';
export type {
  FairManifestPublishedPayload,
  ContentEventPayload,
  PublishContentEventInput,
  PublishedContentEvent,
  ContentEvent,
} from './content-publish';
