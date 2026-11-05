import { verifyJwt } from '@metalabel/dfos-protocol/crypto';
import { z } from 'zod';

// 0.55 removed the auth-token wrapper. Keep the #2132 gate's old JWT
// semantics until #3307 reconciles admission with API-AUTH identity proofs.
const claims = z.looseObject({
  iss: z.string(),
  sub: z.string(),
  aud: z.string(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
});

export function verifyAuthToken(options: {
  token: string;
  publicKey: Uint8Array;
  audience: string;
  currentTime?: number;
}) {
  const { header, payload } = verifyJwt(options);
  const parsed = claims.parse(payload);
  const now = options.currentTime ?? Math.floor(Date.now() / 1000);
  if (parsed.iat > now) throw new Error('auth token not yet valid');
  const kid = header.kid;
  if (!kid?.includes('#') || kid.slice(0, kid.indexOf('#')) !== parsed.iss) {
    throw new Error('auth token kid DID does not match issuer');
  }
  return { ...parsed, kid };
}
