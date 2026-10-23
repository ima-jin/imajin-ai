/** #3064 must enforce this cap when issuing certificates, under the CA purpose lock. */
export const SSH_CA_MAX_CERT_TTL_SECONDS = 15 * 60;
export const SSH_CA_DEFAULT_CERT_TTL_SECONDS = 10 * 60;

/** Strict, canonical purpose also makes the OpenSSH comment safe. */
export function isSshCaPurpose(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(value);
}
