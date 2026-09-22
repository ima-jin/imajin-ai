import { createCorpusApp } from './routes';
import { bootstrapKernelTrust } from './lib/kernel-trust';

const port = Number.parseInt(process.env.PORT ?? '8003', 10);

// Fetch-and-pin (TOFU) the kernel's signing public key before accepting any
// requests (#2244) — access-claim.ts's verifier needs a resolved trust root
// on the very first request, not just eventually.
await bootstrapKernelTrust();

const app = createCorpusApp();

app.listen(port, () => {
  console.log(`Corpus service listening on :${port}`);
});
