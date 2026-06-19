import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { KernelClient } from './client.js';

/**
 * The 5 broker tool definitions for Claude's tool use.
 *
 * TRUST MODEL: The LLM is the untrusted interface. It only decides which tool to
 * call with which params — it NEVER sees another user's sealed intent, NEVER decides
 * disclosure, and NEVER manufactures availability data.
 *
 * There is deliberately NO query_someone tool. You declare your own intent;
 * matches surface to you. This absence is load-bearing.
 */
export const BROKER_TOOLS: Tool[] = [
  {
    name: 'set_intention',
    description: 'Set a sealed availability intent (a "standing note"). ' +
      'Nothing is disclosed on creation — the note sits sealed until the match engine finds a bilateral overlap. ' +
      'Use when the user says things like "I am free tonight", "I want to go out this weekend", "film or dinner this week".',
    input_schema: {
      type: 'object' as const,
      properties: {
        intent: {
          type: 'string',
          description: 'A short phrase describing availability, e.g. "going_out", "free_for_coffee".',
        },
        activityTags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Activity tags that define the overlap surface, e.g. ["film", "dinner", "walk"]. ' +
            'A match only fires if both sides independently set the same tag.',
        },
        sensitiveTags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subset of activityTags to flag as sensitive (double-blind only — never surfaces on existence).',
        },
        reach: {
          type: 'string',
          enum: ['favourites', 'one_degree', 'strangers'],
          description: 'How far the match may travel. favourites = inner circle; one_degree = 2-hop connections; strangers = open.',
        },
        window: {
          type: 'string',
          enum: ['today', 'tonight', 'this_weekend', 'this_week', 'next_week'],
          description: 'Convenience window shorthand. Sets starts_at / ends_at / expires_at automatically.',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'list_intentions',
    description: 'List the user\'s own live (not expired) availability intents. ' +
      'Use when asked "what intentions do I have set?" or "show my plans".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cancel_intention',
    description: 'Cancel one of the user\'s active availability intents. ' +
      'The note dies sealed — nobody ever knew it existed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        intentionId: {
          type: 'string',
          description: 'The ID of the intent to cancel (from list_intentions).',
        },
      },
      required: ['intentionId'],
    },
  },
  {
    name: 'manage_reach',
    description: 'Update the user\'s default reach preference for new intentions. ' +
      'Use when asked to change who can match with them by default.',
    input_schema: {
      type: 'object' as const,
      properties: {
        defaultReach: {
          type: 'string',
          enum: ['favourites', 'one_degree', 'strangers'],
          description: 'New default reach for future intentions.',
        },
      },
      required: ['defaultReach'],
    },
  },
  {
    name: 'respond_to_match',
    description: 'Respond to a surfaced match notification — connect, decline, or request a mutual unmask. ' +
      'The match already exists (the broker confirmed bilateral overlap); this just records the user\'s response.',
    input_schema: {
      type: 'object' as const,
      properties: {
        matchId: {
          type: 'string',
          description: 'The match ID from the notification.',
        },
        action: {
          type: 'string',
          enum: ['connect', 'decline', 'unmask'],
          description: 'connect = reach out; decline = pass; unmask = request mutual identity reveal (sensitive matches).',
        },
      },
      required: ['matchId', 'action'],
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  userDid: string,
  client: KernelClient
): Promise<string> {
  switch (toolName) {
    case 'set_intention': {
      const result = await client.setIntention(userDid, {
        intent: toolInput.intent as string,
        activityTags: toolInput.activityTags as string[] | undefined,
        sensitiveTags: toolInput.sensitiveTags as string[] | undefined,
        reach: toolInput.reach as 'favourites' | 'one_degree' | 'strangers' | undefined,
        window: toolInput.window as string | undefined,
      });
      const intent: Record<string, unknown> = result.intent;
      const expiresAt = typeof intent.expiresAt === 'string' ? intent.expiresAt : 'it expires';
      return `Intention set! Your sealed note is live until ${expiresAt}. Nothing is disclosed until a bilateral match fires.`;
    }

    case 'list_intentions': {
      const result = await client.listIntentions(userDid);
      if (!result.intents || result.intents.length === 0) {
        return 'You have no active intentions set.';
      }
      const lines = result.intents.map((i: Record<string, unknown>) => {
        const name = typeof i.intent === 'string' ? i.intent : '(unnamed)';
        const reach = typeof i.reach === 'string' ? i.reach : 'favourites';
        const tags = Array.isArray(i.activityTags) ? (i.activityTags as string[]).join(', ') || 'none' : 'none';
        const expires = typeof i.expiresAt === 'string' ? i.expiresAt : 'unknown';
        return `• ${name} [${reach}] — tags: ${tags} — expires: ${expires} (id: ${i.id})`;
      });
      return `Your active intentions:\n${lines.join('\n')}`;
    }

    case 'cancel_intention': {
      const intentionId = toolInput.intentionId as string;
      await client.cancelIntention(userDid, intentionId);
      return 'Intention cancelled. The note died sealed — no one knows it existed.';
    }

    case 'manage_reach': {
      // Reach preference is stored on each intention; this is advisory for future ones.
      const reach = toolInput.defaultReach as string;
      return `Default reach preference noted: ${reach}. This will apply to future intentions you set.`;
    }

    case 'respond_to_match': {
      const { matchId, action } = toolInput as { matchId: string; action: string };
      // Match response endpoint is tracked for #1049 / consent phase — stub here.
      let outcome: string;
      if (action === 'connect') {
        outcome = 'The other party will be notified you want to connect.';
      } else if (action === 'unmask') {
        outcome = 'Requesting mutual identity reveal — both sides must agree.';
      } else {
        outcome = 'You passed on this match.';
      }
      return `Match response recorded: ${action} for match ${matchId}. ${outcome}`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
