import { createCorpusApp } from './routes';
import { bootstrapKernelTrust } from './lib/kernel-trust';
import { bootstrapCorpusIdentity } from './lib/corpus-identity';
import { bootstrapAttestationInternalApiKey } from './lib/attestation-key';

const port = Number.parseInt(process.env.PORT ?? '8003', 10);

// Fetch-and-pin (TOFU) the kernel's signing public key before accepting any
// requests (#2244) — access-claim.ts's verifier needs a resolved trust root
// on the very first request, not just eventually.
await bootstrapKernelTrust();

// Fetch corpus's own signing key from the vault before accepting any
// requests (#2243) — a soft-fail on failure, same as every other identity
// absence in this service (see corpus-identity.ts).
await bootstrapCorpusIdentity();

// Fetch the shared ATTESTATION_INTERNAL_API_KEY from the vault before
// accepting any requests (#2245) — a soft-fail on failure, same posture as
// bootstrapCorpusIdentity above (see attestation-key.ts).
await bootstrapAttestationInternalApiKey();

const app = createCorpusApp();

app.listen(port, () => {
  console.log(`Corpus service listening on :${port}`);
});
