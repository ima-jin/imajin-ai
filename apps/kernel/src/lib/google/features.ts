/** Operator approval is opt-in; truthy strings must not enable Business Profile. */
export function isBusinessProfileEnabled(): boolean {
  return process.env.GOOGLE_BUSINESS_PROFILE_ENABLED === 'true';
}
