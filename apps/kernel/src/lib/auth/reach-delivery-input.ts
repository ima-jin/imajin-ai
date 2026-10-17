
export interface ReachDeliveryInput {
  message: string;
  topic: string;
  /** Opaque caller-owned transport reference. Never fetched or interpreted by the kernel. */
  replyHandle: string;
}

export const MAX_REACH_MESSAGE_LENGTH = 16_000;
export const MAX_REPLY_HANDLE_LENGTH = 2_000;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Delivery is an all-or-nothing bundle; an absent bundle keeps the #2251 ask contract. */
export function parseReachDelivery(body: Record<string, unknown>):
  | { ok: true; delivery?: ReachDeliveryInput }
  | { ok: false; error: string } {
  const { message, topic, replyHandle } = body;
  if (message === undefined && topic === undefined && replyHandle === undefined) return { ok: true };
  if (!boundedText(message, MAX_REACH_MESSAGE_LENGTH)) {
    return { ok: false, error: `message must be non-empty text of at most ${MAX_REACH_MESSAGE_LENGTH} characters` };
  }
  if (!boundedText(topic, 200)) {
    return { ok: false, error: 'topic must be non-empty text of at most 200 characters' };
  }
  if (!boundedText(replyHandle, MAX_REPLY_HANDLE_LENGTH)) {
    return { ok: false, error: `replyHandle must be non-empty text of at most ${MAX_REPLY_HANDLE_LENGTH} characters` };
  }
  // A caller cannot get topic B through a predicate that merely admits A.
  if (body.purpose !== 'agent.reach' || body.field !== 'contact_topics'
    || body.predicate !== 'contains' || body.arg !== topic) {
    return { ok: false, error: 'delivery requires agent.reach / contact_topics / contains with arg equal to topic' };
  }
  return { ok: true, delivery: { message, topic, replyHandle } };
}
