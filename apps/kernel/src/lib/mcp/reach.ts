import { reachPrincipalWithCredential } from '@/src/lib/auth/agent-reach';
import { reachStatus } from '@/src/lib/auth/reach-status';
import type { resolveReachBearer } from '@/src/lib/access/reach-bearer';
import { publishedTopicLabels } from '@/src/lib/jin/front-door';
import { MAX_REACH_MESSAGE_LENGTH, MAX_REPLY_HANDLE_LENGTH } from '@/src/lib/auth/reach-delivery-input';
import { discoverResult } from './protocol';
import type { McpSurface } from './server';
import type { McpTool } from './types';
import { reachResourceUrls } from './reach-resource';

type Credential = NonNullable<Awaited<ReturnType<typeof resolveReachBearer>>>;
interface ReachPrincipal {
  id: string;
  metadata: Record<string, unknown> | null;
}

const topicSchema = { type: 'string', minLength: 1, maxLength: 200 };

function text(args: Record<string, unknown>, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${key} must be non-empty text of at most ${max} characters`);
  }
  return value;
}

/** No global state: recipient and credential are bound for this request only. */
export function createReachSurface(
  principal: ReachPrincipal,
  handle: string,
  credential: Credential | null,
  outcome: { status: number },
): McpSurface {
  const urls = reachResourceUrls(handle);
  const tools: McpTool[] = [
    {
      name: 'reach_card',
      description: 'Read this principal’s public reach card and published topics. No credential required.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => [{ type: 'text', text: JSON.stringify({
        principalDid: principal.id,
        topics: publishedTopicLabels(principal.metadata),
        mcp: urls.resource,
        authentication: { scope: 'agent:reach', knock: urls.knock },
        instructions: 'Obtain your own reach bearer from knock, send with reach_send, then poll reach_status for the principal-signed reply.',
      }) }],
    },
    gatedTool('reach_ask', 'Ask whether this principal admits a topic. Returns only a boolean, never private gate rules.',
      { topic: topicSchema }, ['topic']),
    gatedTool('reach_send', 'Deliver a message to this principal in one call. Save the returned reachId and use reach_status to read their reply.',
      {
        topic: topicSchema,
        message: { type: 'string', minLength: 1, maxLength: MAX_REACH_MESSAGE_LENGTH },
        replyHandle: { type: 'string', minLength: 1, maxLength: MAX_REPLY_HANDLE_LENGTH, description: 'Opaque caller reference, never fetched. Optional when polling reach_status.' },
      }, ['topic', 'message']),
    gatedTool('reach_status', 'Read delivery state and the principal-signed reply for a reach you sent. Only your own receipts are accessible.',
      { reachId: { type: 'string', minLength: 1, maxLength: 200 } }, ['reachId']),
  ];

  function gatedTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): McpTool {
    return {
      name, description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      async handler(args) {
        if (!credential) {
          outcome.status = 401;
          throw new Error('A reach credential is required');
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some((key) => !Object.hasOwn(properties, key))) {
          throw new Error('Invalid tool arguments');
        }
        // Validate before the service boundary; thrown infrastructure errors are
        // sanitized below, never reflected with DB parameters or credentials.
        const body = argumentsFor(name, args);
        try {
          const result = name === 'reach_status'
            ? await reachStatus({ principalDid: principal.id, requesterDid: credential.requesterDid, reachId: body.reachId as string })
            : await reachPrincipalWithCredential(principal.id, credential, body);
          if (!result) {
            outcome.status = 404;
            throw new Error('Reach not found');
          }
          if ('denied' in result) {
            outcome.status = result.status;
            throw new Error('Reach request denied');
          }
          return [{ type: 'text', text: JSON.stringify(result) }];
        } catch {
          if (outcome.status === 200) outcome.status = 503;
          throw new Error(outcome.status === 404 ? 'Reach not found' : 'Reach request failed');
        }
      },
    };
  }

  return {
    tools,
    discovery: {
      ...discoverResult(),
      instructions: 'Per-principal reach: reach_card is public; reach_ask, reach_send and reach_status require your own knock-issued static-header reach bearer. Send a message in one reach_send call; poll reach_status for the reply. No owner resources are exposed.',
    },
  };
}

function argumentsFor(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'reach_status') return { reachId: text(args, 'reachId', 200) };
  const topic = text(args, 'topic', 200);
  // An ask has no delivery bundle. Passing `topic` alone would correctly fail
  // the canonical all-or-nothing delivery parser.
  if (name === 'reach_ask') return { arg: topic };
  return {
    topic,
    message: text(args, 'message', MAX_REACH_MESSAGE_LENGTH),
    replyHandle: args.replyHandle === undefined ? 'mcp:reach_status' : text(args, 'replyHandle', MAX_REPLY_HANDLE_LENGTH),
  };
}
