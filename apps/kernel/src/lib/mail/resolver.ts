import { DEFAULT_SENDERS, MAIL_PURPOSES, type MailPurpose, type SenderConfig } from './types';
import { listSenderConfigs, resolveMailOwner } from './store';
import { isDomainMailReady } from './readiness';
import { validateSenderConfig } from './validation';

export interface SenderResolution {
  from: string;
  replyTo?: string;
  source: 'default' | 'owner' | 'app';
}

async function readySender(config: SenderConfig | undefined): Promise<SenderResolution | undefined> {
  if (!config) return undefined;
  let valid: SenderConfig;
  try { valid = validateSenderConfig(config); } catch { return undefined; }
  try {
    if (!await isDomainMailReady(valid.ownerDid, valid.domain)) return undefined;
  } catch { return undefined; }
  return {
    from: `${valid.displayName} <${valid.localPart}@${valid.domain}>`,
    ...(valid.replyTo ? { replyTo: valid.replyTo } : {}),
    source: valid.appDid ? 'app' : 'owner',
  };
}

export async function resolveSender(options: { purpose: MailPurpose; ownerDid?: string; appDid?: string }): Promise<SenderResolution> {
  return (await resolveMailSenderContext(options)).sender;
}

/** Shared internal context keeps audit attribution and sender selection on one registry lookup. */
export async function resolveMailSenderContext(options: { purpose: MailPurpose; ownerDid?: string; appDid?: string }): Promise<{ sender: SenderResolution; ownerDid?: string }> {
  if (!MAIL_PURPOSES.includes(options.purpose)) throw new Error('Invalid mail purpose');
  const ownerDid = await resolveMailOwner(options.ownerDid, options.appDid);
  const fallback: SenderResolution = { from: DEFAULT_SENDERS[options.purpose], source: 'default' };
  if (!ownerDid) return { sender: fallback };
  const configs = (await listSenderConfigs(ownerDid)).filter(row => row.ownerDid === ownerDid && row.purpose === options.purpose);
  const app = options.appDid ? configs.find(row => row.appDid === options.appDid) : undefined;
  const sender = await readySender(app) ??
    await readySender(configs.find(row => row.appDid === '')) ??
    fallback;
  return { sender, ownerDid };
}
