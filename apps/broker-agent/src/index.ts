import 'dotenv/config';
import { KernelClient } from './client.js';
import { TokenProvider } from './token.js';
import { createBot, startMatchDelivery } from './bot.js';

const KERNEL_URL     = process.env.KERNEL_URL;
const APP_DID        = process.env.APP_DID;
const APP_PRIVATE_KEY = process.env.APP_PRIVATE_KEY;

if (!KERNEL_URL)      throw new Error('KERNEL_URL is required');
if (!APP_DID)         throw new Error('APP_DID is required');
if (!APP_PRIVATE_KEY) throw new Error('APP_PRIVATE_KEY is required');

const tokenProvider = new TokenProvider(KERNEL_URL, APP_DID, APP_PRIVATE_KEY);
const kernelClient  = new KernelClient(KERNEL_URL, tokenProvider);
const bot = createBot(kernelClient);

// Start match delivery polling loop.
const deliveryTimer = startMatchDelivery(bot, kernelClient);

// Start Telegram long-polling.
bot.start({
  onStart: (info) => {
    console.log(`[broker-agent] Bot started: @${info.username}`);
    console.log(`[broker-agent] Kernel: ${KERNEL_URL}`);
    console.log(`[broker-agent] Match delivery polling every ${process.env.MATCH_POLL_INTERVAL_MS ?? 30000}ms`);
  },
});

// Graceful shutdown.
process.once('SIGINT', () => {
  clearInterval(deliveryTimer);
  tokenProvider.dispose();
  bot.stop();
});
process.once('SIGTERM', () => {
  clearInterval(deliveryTimer);
  tokenProvider.dispose();
  bot.stop();
});
