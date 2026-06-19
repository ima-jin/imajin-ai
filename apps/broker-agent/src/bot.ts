import { Bot } from 'grammy';
import { KernelClient, type PendingNotification } from './client.js';
import { routeMessage } from './agent.js';

const POLL_INTERVAL_MS = Number.parseInt(process.env.MATCH_POLL_INTERVAL_MS ?? '30000', 10);

/** Render a surfaced match notification as a Telegram message. */
function renderMatch(n: PendingNotification): string {
  const tags = n.overlapTags.length > 0 ? n.overlapTags.join(', ') : 'shared interests';

  switch (n.deliveryPolicy) {
    case 'named_nudge':
      // Both are favourites and non-sensitive — name the other party.
      return [
        '✨ *A match just surfaced*',
        '',
        `You and ${n.otherDid ? `\`${n.otherDid.slice(0, 20)}…\`` : 'someone in your circle'} are both up for: *${tags}*`,
        '',
        'You reached each other because you both set overlapping intentions.',
        `Match ID: \`${n.matchId}\``,
        '',
        'Reply with "connect", "decline", or "unmask" to respond.',
      ].join('\n');

    case 'staged':
      // Arriver sees first — staged reveal.
      return [
        '✨ *A match surfaced*',
        '',
        `Someone in your network is also up for: *${tags}*`,
        '',
        'This surfaced because you both independently set the same intent — no one looked you up.',
        `Match ID: \`${n.matchId}\``,
        '',
        'Reply "connect" to reach out, or "decline" to pass.',
      ].join('\n');

    case 'sensitive_staged':
      // Sensitive match — identities withheld entirely.
      return [
        '🔒 *A mutual match exists*',
        '',
        'Someone set the same intention as you. Identities are withheld until both sides agree to unmask.',
        `Match ID: \`${n.matchId}\``,
        '',
        'Reply "unmask" if you want to reveal identities (requires mutual agreement).',
      ].join('\n');

    default:
      return `A match was found (ID: ${n.matchId}). Reply "connect" or "decline".`;
  }
}

export function createBot(kernelClient: KernelClient): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const bot = new Bot(token);

  // ─── Message handler ─────────────────────────────────────────────────────

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;

    // Special case: /start
    if (text === '/start') {
      const linked = await kernelClient.resolveChannelLink(chatId);
      if (linked) {
        await ctx.reply(
          'Welcome back! Your Imajin account is linked. What are you up for?'
        );
        return;
      }
      const link = await kernelClient.startChannelLink(chatId).catch(() => null);
      if (link) {
        await ctx.reply(
          'Hi! To use this bot, link your Imajin account:\n\n' +
          `${link.url}\n\n` +
          `This link expires in 15 minutes. After linking, come back and tell me what you're up for!`
        );
      } else {
        await ctx.reply('Unable to generate a link right now. Please try again shortly.');
      }
      return;
    }

    // Resolve chat_id → Imajin DID
    const linked = await kernelClient.resolveChannelLink(chatId);

    if (!linked) {
      // Not linked — offer the linking flow.
      const link = await kernelClient.startChannelLink(chatId).catch(() => null);
      if (link) {
        await ctx.reply(
          'I don\'t recognise this Telegram account yet. Link it to your Imajin identity first:\n\n' +
          `${link.url}\n\n` +
          'After linking, come back and I can set intentions and deliver matches for you.'
        );
      } else {
        await ctx.reply('Unable to generate a link right now. Please try again shortly.');
      }
      return;
    }

    // Linked — route through Claude with the broker tools.
    const userDid = linked.did;
    await ctx.replyWithChatAction('typing');

    const reply = await routeMessage(userDid, text, kernelClient).catch(
      (err: unknown) => `Sorry, something went wrong: ${String(err)}`
    );

    await ctx.reply(reply, { parse_mode: 'Markdown' });
  });

  bot.catch((err) => {
    console.error('[bot] Unhandled error:', err);
  });

  return bot;
}

// ─── Match delivery loop ──────────────────────────────────────────────────

export function startMatchDelivery(bot: Bot, kernelClient: KernelClient): NodeJS.Timeout {
  const deliverPending = async (): Promise<void> => {
    try {
      const { notifications } = await kernelClient.getPendingMatches();
      if (notifications.length === 0) return;

      const delivered: string[] = [];

      for (const n of notifications) {
        if (!n.channelUid) continue; // no chat to deliver to
        try {
          const text = renderMatch(n);
          await bot.api.sendMessage(n.channelUid, text, { parse_mode: 'Markdown' });
          delivered.push(n.id);
        } catch (err) {
          console.error(`[delivery] Failed to deliver match ${n.id} to ${n.channelUid}:`, err);
        }
      }

      if (delivered.length > 0) {
        await kernelClient.markMatchesDelivered(delivered);
        console.log(`[delivery] Delivered ${delivered.length} match notification(s)`);
      }
    } catch (err) {
      console.error('[delivery] Poll error:', err);
    }
  };

  // Run immediately then on interval.
  void deliverPending();
  return setInterval(() => void deliverPending(), POLL_INTERVAL_MS);
}
