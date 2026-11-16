require('dotenv').config();
const express = require('express');
const igManager = require('./lib/igClient');
const replyEngine = require('./lib/replyEngine');
const db = require('./lib/db');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000', 10);
const PORT = process.env.PORT || 3005;

let isPolling = false;
let botUserId = null;
let ig = null;
let botStats = {
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  status: 'initializing',
};

// Sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * STRICTLY ONLY replies to direct incoming messages (DMs).
 * Does NOT like, follow, comment, view stories or perform any other action.
 */
async function processThread(thread) {
  if (!thread || !Array.isArray(thread.items) || thread.items.length === 0) {
    return;
  }

  const latestItem = thread.items[0];

  // 1. Skip if message was sent by the bot itself
  if (String(latestItem.user_id) === String(botUserId)) {
    return;
  }

  // 2. Skip if already processed in Turso DB / memory cache
  if (db.isMessageProcessed(latestItem.item_id)) {
    return;
  }

  // 3. STRICT RULE: ONLY process plain text DMs from real users.
  // Ignore story shares, media, links, voice messages, reactions, system notifications.
  if (latestItem.item_type !== 'text' || !latestItem.text) {
    return;
  }

  const userMessage = String(latestItem.text).trim();
  if (!userMessage) {
    return;
  }

  const senderId = latestItem.user_id;

  // Find sender username if available in thread
  const senderUser = (thread.users || []).find((u) => String(u.pk) === String(senderId));
  const senderUsername = senderUser ? senderUser.username : 'user';

  console.log(`\n📩 [New DM] From @${senderUsername}: "${userMessage}"`);

  // Per-user rate limit (minimum 8 seconds cooldown between replies)
  if (!db.canReplyToUser(senderId, 8)) {
    console.log(`⏳ [Cooldown] Skipping reply to @${senderUsername} (rate limited)`);
    return;
  }

  try {
    // Mark seen
    const directThread = ig.entity.directThread(thread.thread_id);
    try {
      await directThread.markItemSeen(latestItem.item_id);
    } catch (_) {}

    // Generate reply (rules.json -> Groq AI fallback)
    const reply = await replyEngine.generateReply(userMessage, senderUsername);

    if (reply && reply.text) {
      // Natural human typing delay (2 to 4 seconds)
      const typingDelay = Math.floor(Math.random() * 2000) + 2000;
      await sleep(typingDelay);

      // Send the text reply in the DM thread
      await directThread.broadcastText(reply.text);

      // Record in Turso DB
      await db.recordProcessedMessage({
        itemId: latestItem.item_id,
        threadId: thread.thread_id,
        senderId: senderId,
        senderUsername: senderUsername,
        incomingText: userMessage,
        replyText: reply.text,
        source: reply.source
      });

      console.log(`🤖 [Replied (${reply.source})] to @${senderUsername}: "${reply.text}"`);
    } else {
      console.log(`ℹ️ [Ignored] No matching rule or AI response for message.`);
    }
  } catch (err) {
    console.error(`❌ [Error replying to @${senderUsername}]:`, err.message);
  }
}

async function pollInbox() {
  if (isPolling) return;
  isPolling = true;

  try {
    botStats.lastPollAt = new Date().toISOString();
    const inboxFeed = ig.feed.directInbox();
    const threads = await inboxFeed.items();

    for (const thread of threads) {
      await processThread(thread);
    }
  } catch (err) {
    if (err.message && err.message.includes('feedback_required')) {
      console.warn('⚠️ [RateLimit] Action temporarily throttled by Instagram. Pausing 2 minutes...');
      await sleep(120000);
    } else {
      console.warn('⚠️ [Polling Error]:', err.message);
    }
  } finally {
    isPolling = false;
  }
}

async function startBot() {
  try {
    console.log('==================================================');
    console.log('🚀 Starting Instagram DM Auto-Reply Bot (Turso DB)...');
    console.log('📌 Policy: STRICTLY ONLY replies to messages (DMs).');
    console.log('==================================================');

    // 1. Initialize Turso DB tables & cache
    await db.init();

    // 2. Login or restore Instagram session
    ig = await igManager.login();
    const currentUser = await ig.account.currentUser();
    botUserId = currentUser.pk;

    console.log(`🤖 Bot Active! Listening to DMs for @${currentUser.username} (ID: ${botUserId})`);
    botStats.status = 'active';

    // 3. Start inbox polling loop
    setInterval(pollInbox, POLL_INTERVAL);
    // Run initial poll
    pollInbox();
  } catch (err) {
    console.error('💥 Fatal initialization error:', err.message);
    botStats.status = 'error: ' + err.message;
    console.log('💡 Tip: Ensure IG_USERNAME and IG_PASSWORD in .env are correct.');
  }
}

// Lightweight HTTP status server
const app = express();
app.get('/', async (req, res) => {
  const dbStats = await db.getStats();
  res.json({
    name: 'Instagram DM Auto-Reply Bot',
    policy: 'Only replies to incoming text messages',
    database: 'Turso DB',
    stats: {
      ...botStats,
      ...dbStats
    },
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Bot Web Status running at http://localhost:${PORT}`);
  startBot();
});

// Graceful exit
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping bot gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Stopping bot gracefully...');
  process.exit(0);
});
