import { and, eq, isNull } from 'drizzle-orm';
import { db, channelLinks, identities, identityMembers } from '@/src/db';
import { APP_TOKEN_DEFAULT_AUDIENCE, verifyAppToken } from './jwt';
import { resolveConnectionPrincipal } from '@/src/lib/kernel/connection-principal';
import { isAgentCapableSubtype, isOrgScope } from '@/src/lib/kernel/connection-principal-policy';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';

export const CHANNEL_LINK_HEADERS = { 'Cache-Control': 'private, no-store' };
const CHANNELS = new Set(['telegram', 'whatsapp', 'signal']);
const forbidden = () => new ExternalMcpError(403, 'Assigned org bot acting as its org required');
function agentCredential(request: Request) {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) return authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  return request.headers.get('x-api-key');
}

/** Same per-agent app+jwt as /infer/v1/self; no session or service-token fallback. */
export async function requireChannelBot(request: Request) {
  const token = agentCredential(request);
  if (!token) throw new ExternalMcpError(401, 'Agent app token required');
  const claims = await verifyAppToken(token);
  if (!claims) throw new ExternalMcpError(401, 'Invalid or expired app token');
  if (claims.isServiceToken || !claims.sub || claims.sub !== claims.azp
    || claims.aud !== APP_TOKEN_DEFAULT_AUDIENCE
    || !claims.scope.split(' ').includes('infer:completions')
    || claims.actingFor || request.headers.has('x-acting-for')) throw forbidden();
  const orgDid = request.headers.get('x-acting-as');
  if (!orgDid || orgDid === claims.sub) throw forbidden();
  const [actor] = await db.select({ subtype: identities.subtype }).from(identities)
    .where(eq(identities.id, claims.sub)).limit(1);
  const [org] = await db.select({ scope: identities.scope }).from(identities)
    .where(eq(identities.id, orgDid)).limit(1);
  if (!isAgentCapableSubtype(actor?.subtype) || !org || !isOrgScope(org.scope)) throw forbidden();
  // Reuses requireAgentAssignment, including live identity and service restrictions.
  await resolveConnectionPrincipal({ actorDid: claims.sub, actingAs: orgDid }, 'infer');
  return { botDid: claims.azp, orgDid };
}

export async function readChannelSender(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ExternalMcpError(400, 'JSON object required');
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['channel', 'channelUid'].includes(key))) {
    throw new ExternalMcpError(400, 'Only channel and channelUid are accepted');
  }
  if (typeof input.channel !== 'string' || !CHANNELS.has(input.channel)) {
    throw new ExternalMcpError(400, 'channel must be telegram, whatsapp or signal');
  }
  if (typeof input.channelUid !== 'string' || !input.channelUid.trim()) {
    throw new ExternalMcpError(400, 'channelUid is required');
  }
  return { channel: input.channel, channelUid: input.channelUid.trim() };
}

export async function resolveChannelSpeaker(botDid: string, orgDid: string, channel: string, channelUid: string) {
  const [link] = await db.select({ did: channelLinks.did }).from(channelLinks).where(and(
    eq(channelLinks.channel, channel), eq(channelLinks.channelUid, channelUid),
    eq(channelLinks.appDid, botDid), eq(channelLinks.status, 'active'),
  )).limit(1);
  if (!link) return { did: null, admitted: false, reason: 'unknown_sender' };
  const { did } = link;
  const [sender] = await db.select({ subtype: identities.subtype }).from(identities)
    .where(eq(identities.id, did)).limit(1);
  if (isAgentCapableSubtype(sender?.subtype)) {
    return { did, admitted: false, reason: sender?.subtype === 'presence' ? 'presence_refused' : 'agent_refused' };
  }
  const membership = and(eq(identityMembers.identityDid, orgDid), eq(identityMembers.memberDid, did));
  const [active] = await db.select({ memberDid: identityMembers.memberDid }).from(identityMembers)
    .where(and(membership, isNull(identityMembers.removedAt))).limit(1);
  if (active) return { did, admitted: true, reason: null };
  const [previous] = await db.select({ memberDid: identityMembers.memberDid }).from(identityMembers)
    .where(membership).limit(1);
  return { did, admitted: false, reason: previous ? 'removed' : 'not_member' };
}

export function channelLinkError(error: unknown) {
  return error instanceof ExternalMcpError
    ? { error: error.message, status: error.status }
    : { error: 'Channel link unavailable', status: 503 };
}
