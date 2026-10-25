import { CorpusStore } from '../engine/store';
import { bootstrapCorpusIdentity, loadCorpusIdentity, markCorpusIdentityUsedForSigning } from './corpus-identity';
import { bootstrapAttestationInternalApiKey } from './attestation-key';
import { resolveCorpusDid } from './source-owner';

const USAGE = 'Usage: tsx src/migrate-owners.ts <legacyDid> <github:owner/repo> --expect-owner <did>';

/** Expected owner is a safety assertion, never an instruction to select a partition. */
export async function migrateCorpusOwner(args: readonly string[]) {
  const [fromDid, source, flag, expectedOwnerDid] = args;
  if (args.length !== 4 || !fromDid || !source?.startsWith('github:') || flag !== '--expect-owner'
    || !/^did:imajin:\S+$/.test(expectedOwnerDid ?? '')) throw new Error(USAGE);
  await bootstrapAttestationInternalApiKey();
  // This lookup must never mint a group, including on an absent alias.
  const toDid = await resolveCorpusDid(source, fromDid, { createIfMissing: false });
  if (toDid !== expectedOwnerDid) throw new Error('Resolved corpus owner does not match --expect-owner');
  await bootstrapCorpusIdentity();
  const identity = loadCorpusIdentity();
  if (!identity) throw new Error('Corpus signing identity is required for owner migration');
  const store = new CorpusStore();
  try {
    const result = store.transferSource(fromDid, toDid, source, identity);
    if (result.moved > 0) markCorpusIdentityUsedForSigning();
    return { source, fromDid, toDid, ...result };
  } finally {
    store.close();
  }
}
