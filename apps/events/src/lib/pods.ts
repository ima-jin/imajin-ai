/**
 * Trust pod integration helpers for events
 * Uses raw SQL via the postgres client since trust-graph and chat tables
 * aren't in the events drizzle schema
 */

import { getClient } from '@imajin/db';
import { randomBytes } from 'crypto';

const sql = getClient();

export interface CreateEventPodParams {
  eventId: string;
  eventDid: string;
  eventTitle: string;
  creatorDid: string;
}

export interface CreateEventPodResult {
  podId: string;
  conversationId: string;
}

/**
 * Creates a trust pod and group chat conversation for an event
 */
export async function createEventPod(params: CreateEventPodParams): Promise<CreateEventPodResult> {
  const { eventId, eventDid, eventTitle, creatorDid } = params;

  const podId = `pod_${randomBytes(12).toString('hex')}`;
  const conversationId = `conv_${randomBytes(12).toString('hex')}`;

  // Create trust pod
  await sql`
    INSERT INTO trust_pods (id, name, type, owner_did, visibility, created_at, updated_at)
    VALUES (${podId}, ${eventTitle}, 'event', ${eventDid}, 'private', NOW(), NOW())
  `;

  // Add creator as pod member with owner role
  await sql`
    INSERT INTO trust_pod_members (pod_id, did, role, added_by, joined_at)
    VALUES (${podId}, ${creatorDid}, 'owner', ${eventDid}, NOW())
  `;

  // Create group chat conversation linked to the pod
  await sql`
    INSERT INTO chat_conversations (id, type, name, pod_id, visibility, created_by, created_at, updated_at)
    VALUES (${conversationId}, 'group', ${eventTitle + ' Chat'}, ${podId}, 'private', ${creatorDid}, NOW(), NOW())
  `;

  // Add creator as conversation participant
  await sql`
    INSERT INTO chat_participants (conversation_id, did, role, joined_at)
    VALUES (${conversationId}, ${creatorDid}, 'owner', NOW())
  `;

  return { podId, conversationId };
}

export interface AddEventParticipantParams {
  podId: string;
  conversationId: string;
  participantDid: string;
  addedBy: string;
  role?: 'owner' | 'admin' | 'member';
}

/**
 * Adds a participant to an event's pod and group chat
 */
export async function addEventParticipant(params: AddEventParticipantParams): Promise<void> {
  const { podId, conversationId, participantDid, addedBy, role = 'member' } = params;

  // Add to pod members (skip if already there)
  await sql`
    INSERT INTO trust_pod_members (pod_id, did, role, added_by, joined_at)
    VALUES (${podId}, ${participantDid}, ${role}, ${addedBy}, NOW())
    ON CONFLICT (pod_id, did) DO NOTHING
  `;

  // Add to chat participants (skip if already there)
  await sql`
    INSERT INTO chat_participants (conversation_id, did, role, joined_at, invited_by)
    VALUES (${conversationId}, ${participantDid}, ${role}, NOW(), ${addedBy})
    ON CONFLICT (conversation_id, did) DO NOTHING
  `;
}

/**
 * Gets the pod and conversation IDs for an event
 */
export async function getEventPod(eventId: string): Promise<{ podId: string; conversationId: string } | null> {
  const rows = await sql`
    SELECT e.pod_id, c.id as conversation_id
    FROM events e
    LEFT JOIN chat_conversations c ON c.pod_id = e.pod_id
    WHERE e.id = ${eventId}
    LIMIT 1
  `;

  if (!rows.length || !rows[0].pod_id || !rows[0].conversation_id) {
    return null;
  }

  return {
    podId: rows[0].pod_id,
    conversationId: rows[0].conversation_id,
  };
}
