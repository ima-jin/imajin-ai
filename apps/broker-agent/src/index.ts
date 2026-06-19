import 'dotenv/config';
import { KernelClient } from './client.js';
import { createBot, startMatchDelivery } from './bot.js';

const KERNEL_URL = process.env.KERNEL_URL;
const BOT_APP_TOKEN = process.env.BOT_APP_TOKEN;

if (!KERNEL_URL) throw new Error('KERNEL_URL is required');
if (!BOT_APP_TOKEN) throw new Error('BOT_APP_TOKEN is required');

const kernelClient = new KernelClient(KERNEL_URL, BOT_APP_TOKEN);
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
  bot.stop();
});
process.once('SIGTERM', () => {
  clearInterval(deliveryTimer);
  bot.stop();
});
