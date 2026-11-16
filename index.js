require('dotenv').config();
const express = require('express');
const igManager = require('./lib/igClient');
const replyEngine = require('./lib/replyEngine');
const storage = require('./lib/storage');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000', 10);
const PORT = process.env.PORT || 3005;

let isPolling = false;
let botUserId = null;
let ig = null;
let botStats = {
  startedAt: new Date().toISOString(),
  totalRepliesSent: 0,
  lastPollAt: null,
  status: 'initializing',
};

// Sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processThread(thread) {
  if (!thread || !Array.isArray(thread.items) || thread.items.length === 0) {
    return;
  }

  const latestItem = thread.items[0];

  // 1. Skip if message was sent by the bot itself
  if (String(latestItem.user_id) === String(botUserId)) {
    return;
  }

  // 2. Skip if already processed
  if (storage.hasBeenProcessed(latestItem.item_id)) {
    return;
  }

  // 3. Mark processed immediately so duplicate checks in parallel loops don't collide
  storage.markProcessed(latestItem.item_id);

  // 4. We only reply to text messages
  if (latestItem.item_type !== 'text' || !latestItem.text) {
    return;
  }

  const userMessage = latestItem.text.trim();
  const senderId = latestItem.user_id;

  // Find sender username if available
  const senderUser = (thread.users || []).find((u) => String(u.pk) === String(senderId));
  const senderUsername = senderUser ? senderUser.username : 'user';

  console.log(`\n📩 [New DM] From @${senderUsername}: "${userMessage}"`);

  // Check rate limit per user (minimum 8 seconds between replies to avoid spam)
  if (!storage.canReplyToUser(senderId, 8)) {
    console.log(`⏳ [Cooldown] Skipping reply to @${senderUsername} (rate limited)`);
    return;
  }

  try {
    // 5. Mark message as seen
    const directThread = ig.entity.directThread(thread.thread_id);
    try {
      await directThread.markItemSeen(latestItem.item_id);
    } catch (_) {}

    // 6. Generate reply using ReplyEngine (Rules -> Groq AI)
    const reply = await replyEngine.generateReply(userMessage, senderUsername);

    if (reply && reply.text) {
      // 7. Human-like typing delay (2 to 4 seconds)
      const typingDelay = Math.floor(Math.random() * 2000) + 2000;
      await sleep(typingDelay);

      // 8. Broadcast reply text
      await directThread.broadcastText(reply.text);
      botStats.totalRepliesSent++;

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
    // Handle transient network errors or rate limit pauses
    if (err.message && err.message.includes('feedback_required')) {
      console.warn('⚠️ [RateLimit] Action temporarily blocked by Instagram. Pausing 2 minutes...');
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
    console.log('==========================================');
    console.log('🚀 Starting Instagram Auto-Reply Bot...');
    console.log('==========================================');

    ig = await igManager.login();
    const currentUser = await ig.account.currentUser();
    botUserId = currentUser.pk;

    console.log(`🤖 Bot Active! Listening to DMs for @${currentUser.username} (ID: ${botUserId})`);
    botStats.status = 'active';

    // Start polling loop
    setInterval(pollInbox, POLL_INTERVAL);
    // Initial run
    pollInbox();
  } catch (err) {
    console.error('💥 Fatal initialization error:', err.message);
    botStats.status = 'error: ' + err.message;
    console.log('💡 Tip: Ensure IG_USERNAME and IG_PASSWORD in .env are correct.');
  }
}

// Lightweight HTTP status server
const app = express();
app.get('/', (req, res) => {
  res.json({
    name: 'Instagram Auto-Reply Bot',
    stats: botStats,
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Bot Web Status running at http://localhost:${PORT}`);
  startBot();
});

// Graceful exit
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping bot gracefully...');
  storage.save();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Stopping bot gracefully...');
  storage.save();
  process.exit(0);
});
