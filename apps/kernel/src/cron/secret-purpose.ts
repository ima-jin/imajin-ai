/**
 * Purpose label for the vault-generated internal secret that gates every
 * `/api/cron/*` route and `GET /api/admin/cron-status` (#2550, following the
 * #2245 `ATTESTATION_INTERNAL_API_KEY` pattern under epic #2241).
 *
 * Kept in its own dependency-free module because three parties must agree on
 * it and not all of them may load the kernel's Next/DB layer:
 *   - the kernel (`./secret.ts`) self-provisions it via `getInternalSecret`;
 *   - the `*-kernel-cron` scheduler (`./vault-secret.ts`) fetches it with
 *     `loadFromVault({ resolveGrantByPurpose })`, under plain `node --import tsx`;
 *   - `scripts/lib/cron-secret-grant.ts` grants it to the scheduler's
 *     bootstrap identity during deploy.
 */
export const CRON_SECRET_PURPOSE = 'kernel.cron-secret';
