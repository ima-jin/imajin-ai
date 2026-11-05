/**
 * From apps/kernel, with the normal database/signing environment loaded:
 * pnpm exec tsx --tsconfig tsconfig.json scripts/backfill-agent-apps.ts
 * Uses server-attested consent, as /api/auth/authorize does. Never loads agent
 * keys, rewrites registrations, or normalizes an existing live self-grant.
 */
import { backfillAgentApps } from '../src/lib/auth/agent-app';

async function main() {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) throw new Error('AUTH_PRIVATE_KEY is required');
  const results = await backfillAgentApps(privateKey);
  for (const result of results) console.info(JSON.stringify(result));
}

main().then(() => process.exit(0)).catch(() => {
  console.error('Agent app backfill failed; current agent transaction rolled back');
  process.exit(1);
});
