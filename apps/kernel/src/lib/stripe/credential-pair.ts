/** Client-safe validation shared by the connector card and credential ingestion. */
export class StripeCredentialError extends Error {
  constructor(
    readonly code: string,
    readonly field: 'token' | 'publishableKey' | 'webhookSecret',
    message: string,
  ) {
    super(message);
    this.name = 'StripeCredentialError';
  }
}

/** A signing secret is supplied by the owner from Stripe, never generated here. */
export function validateStripeWebhookSecret(secret: string): void {
  if (!/^whsec_\w+$/.test(secret.trim())) {
    throw new StripeCredentialError(
      'stripe_webhook_secret_invalid', 'webhookSecret',
      'Provide the webhook signing secret starting with whsec_ from your Stripe endpoint.',
    );
  }
}

/** Validate prefixes and matching Stripe mode without network or vault access. */
export function validateStripeCredentialPair(token: string, publishableKey: string | undefined): void {
  const restrictedKey = token.trim();
  if (!restrictedKey) {
    throw new StripeCredentialError('stripe_key_missing', 'token', 'token is required: provide a Stripe restricted key.');
  }
  const restrictedMode = /^rk_(test|live)_\w+$/.exec(restrictedKey)?.[1];
  if (!restrictedMode) {
    throw new StripeCredentialError(
      'stripe_key_not_restricted',
      'token',
      'token must be a Stripe restricted key starting with rk_test_ or rk_live_.',
    );
  }

  const publicKey = publishableKey?.trim();
  if (!publicKey) {
    throw new StripeCredentialError(
      'stripe_publishable_key_missing',
      'publishableKey',
      'publishableKey is required: provide the matching Stripe publishable key.',
    );
  }
  const publishableMode = /^pk_(test|live)_\w+$/.exec(publicKey)?.[1];
  if (!publishableMode) {
    throw new StripeCredentialError(
      'stripe_publishable_key_invalid',
      'publishableKey',
      'publishableKey must be a Stripe publishable key starting with pk_test_ or pk_live_.',
    );
  }
  if (restrictedMode !== publishableMode) {
    throw new StripeCredentialError(
      'stripe_key_mode_mismatch',
      'publishableKey',
      'publishableKey and token must use the same Stripe mode (test or live).',
    );
  }
}
