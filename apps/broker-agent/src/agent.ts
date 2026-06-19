import Anthropic from '@anthropic-ai/sdk';
import { BROKER_TOOLS, executeTool } from './tools.js';
import type { KernelClient } from './client.js';

const SYSTEM_PROMPT = `You are the Imajin broker agent — a conversational interface for a privacy-first social coordination system.

Your role:
- Help users set sealed availability intents ("standing notes")
- Show their own active intentions
- Cancel intentions they no longer want
- Deliver surfaced matches when they arrive
- Manage their reach preferences

Trust model (non-negotiable):
- You are the UNTRUSTED interface. You NEVER see another user's sealed intent.
- ALL disclosure decisions happen server-side in the broker. You render results; you cannot manufacture them.
- You have NO ability to query another person's availability. There is no such tool. Do not pretend otherwise.
- If a match surfaces, it is because the broker already confirmed bilateral overlap. You are just the messenger.
- A hallucinated "Ryan is free Friday" has zero data behind it — the broker is the only source of truth.

Tone:
- Friendly, brief, direct.
- When confirming an intention was set: emphasize it is sealed — nothing surfaces until a match fires.
- When delivering a match: emphasize you got here through mutual overlap, not by looking someone up.
- When someone asks to check on another person: explain there is no such path in this system, and gently redirect.`;

const client = new Anthropic();

/**
 * Route a natural language message through Claude with the 5 broker tools.
 * Returns the assistant's final text response.
 *
 * The LLM decides which tool to call; all actual kernel interactions happen
 * through executeTool() which calls the kernel APIs with actingFor=userDid.
 */
export async function routeMessage(
  userDid: string,
  messageText: string,
  kernelClient: KernelClient
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: messageText },
  ];

  // Tool-use loop — keeps going until Claude stops calling tools.
  for (let turn = 0; turn < 5; turn++) {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      tools: BROKER_TOOLS,
      messages,
    });

    // If Claude is done (no tool calls), return its text.
    if (response.stop_reason === 'end_turn' || !response.content.some((b) => b.type === 'tool_use')) {
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : 'Done.';
    }

    // Append Claude's response to the message history.
    messages.push({ role: 'assistant', content: response.content });

    // Execute all tool calls and collect results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(
        block.name,
        block.input as Record<string, unknown>,
        userDid,
        kernelClient
      ).catch((err: unknown) => `Error: ${String(err)}`);

      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return 'I ran into an issue processing that. Please try again.';
}
