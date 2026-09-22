import { createCorpusApp } from './routes';
import { bootstrapKernelTrust } from './lib/kernel-trust';
import { bootstrapCorpusIdentity } from './lib/corpus-identity';

const port = Number.parseInt(process.env.PORT ?? '8003', 10);

// Fetch-and-pin (TOFU) the kernel's signing public key before accepting any
// requests (#2244) — access-claim.ts's verifier needs a resolved trust root
// on the very first request, not just eventually.
await bootstrapKernelTrust();

// Fetch corpus's own signing key from the vault before accepting any
// requests (#2243) — a soft-fail on failure, same as every other identity
// absence in this service (see corpus-identity.ts).
await bootstrapCorpusIdentity();

const app = createCorpusApp();

app.listen(port, () => {
  console.log(`Corpus service listening on :${port}`);
});
