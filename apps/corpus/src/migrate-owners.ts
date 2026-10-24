import { CorpusStore } from './engine/store';
import { bootstrapCorpusIdentity, loadCorpusIdentity } from './lib/corpus-identity';
import { bootstrapAttestationInternalApiKey } from './lib/attestation-key';
import { resolveCorpusDid } from './lib/source-owner';

/** Run on the corpus host with its normal vault bootstrap configuration, with the daemon stopped. */
const [fromDid, source] = process.argv.slice(2);
if (!fromDid || !source?.startsWith('github:')) throw new Error('Usage: tsx src/migrate-owners.ts <legacyDid> <github:owner/repo>');
await bootstrapCorpusIdentity();
await bootstrapAttestationInternalApiKey();
const identity = loadCorpusIdentity();
if (!identity) throw new Error('Corpus signing identity is required for owner migration');
const toDid = await resolveCorpusDid(source, fromDid);
const store = new CorpusStore();
try {
  const result = store.transferSource(fromDid, toDid, source, identity);
  console.log(JSON.stringify({ source, fromDid, toDid, ...result }));
} finally {
  store.close();
}
