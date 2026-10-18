import { MAIL_PURPOSES, type SenderConfig } from './types';

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_ATOM = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const DID = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/;

export function validateMailDomain(domain: string): string {
  if (typeof domain !== 'string' || domain.length > 253) throw new Error('Invalid mail domain');
  const normalized = domain.toLowerCase();
  const labels = normalized.split('.');
  if (labels.length < 2 || !labels.every(label => DOMAIN_LABEL.test(label))) throw new Error('Invalid mail domain');
  if (!/^[a-z]{2,63}$/.test(labels.at(-1)!)) throw new Error('Invalid mail domain');
  return normalized;
}

function validateLocalPart(value: string): void {
  if (typeof value !== 'string' || value.length > 64 || !value.split('.').every(atom => LOCAL_ATOM.test(atom))) throw new Error('Invalid mail local part');
}

function validateReplyTo(value: string | null): void {
  if (value === null) return;
  if (typeof value !== 'string' || value.length > 254) throw new Error('Invalid reply-to');
  const parts = value.split('@');
  if (parts.length !== 2) throw new Error('Invalid reply-to');
  validateLocalPart(parts[0]);
  validateMailDomain(parts[1]);
}

/** Reject header syntax rather than attempting to escape attacker-controlled headers. */
export function validateSenderConfig(config: SenderConfig): SenderConfig {
  if (!MAIL_PURPOSES.includes(config.purpose)) throw new Error('Invalid mail purpose');
  if (!DID.test(config.ownerDid) || (config.appDid !== '' && !DID.test(config.appDid))) throw new Error('Invalid sender DID');
  validateLocalPart(config.localPart);
  if (typeof config.displayName !== 'string' || config.displayName.length < 1 || config.displayName.length > 100 ||
      /[\p{Cc}\p{Cf}<>"\\,;]/u.test(config.displayName) || config.displayName.trim() !== config.displayName) {
    throw new Error('Invalid sender display name');
  }
  validateReplyTo(config.replyTo);
  return { ...config, domain: validateMailDomain(config.domain) };
}
