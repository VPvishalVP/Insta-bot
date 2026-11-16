require('dotenv').config();
const express = require('express');
const igManager = require('./lib/igClient');
const replyEngine = require('./lib/replyEngine');
const db = require('./lib/db');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000', 10);
const PORT = process.env.PORT || 3005;

let isPolling = false;
let pollingTimer = null;
let botUserId = null;
let ig = null;
let botActive = true;

let botStats = {
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  status: 'initializing',
  error: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * STRICTLY ONLY replies to direct incoming messages (DMs).
 * Does NOT like, follow, comment, view stories or perform any other action.
 */
async function processThread(thread) {
  if (!botActive) return;
  if (!thread || !Array.isArray(thread.items) || thread.items.length === 0) return;

  const latestItem = thread.items[0];

  // 1. Skip if message was sent by the bot itself
  if (String(latestItem.user_id) === String(botUserId)) return;

  // 2. Skip if already processed in Turso DB / memory cache
  if (db.isMessageProcessed(latestItem.item_id)) return;

  // 3. STRICT RULE: ONLY process plain text DMs from real users.
  if (latestItem.item_type !== 'text' || !latestItem.text) return;

  const userMessage = String(latestItem.text).trim();
  if (!userMessage) return;

  const senderId = latestItem.user_id;
  const senderUser = (thread.users || []).find((u) => String(u.pk) === String(senderId));
  const senderUsername = senderUser ? senderUser.username : 'user';

  console.log(`\n📩 [New DM] From @${senderUsername}: "${userMessage}"`);

  // Rate limit check (minimum 8 seconds cooldown per user)
  if (!db.canReplyToUser(senderId, 8)) {
    console.log(`⏳ [Cooldown] Skipping reply to @${senderUsername} (rate limited)`);
    return;
  }

  try {
    const directThread = ig.entity.directThread(thread.thread_id);
    try {
      await directThread.markItemSeen(latestItem.item_id);
    } catch (_) {}

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
  if (!botActive || isPolling || !ig || !igManager.isLoggedIn) return;
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
      console.warn('⚠️ [RateLimit] Action temporarily throttled. Pausing 2 minutes...');
      await sleep(120000);
    } else {
      console.warn('⚠️ [Polling Error]:', err.message);
    }
  } finally {
    isPolling = false;
  }
}

async function startBot(customUsername, customPassword) {
  try {
    console.log('==================================================');
    console.log('🚀 Initializing Instagram DM Auto-Reply Bot...');
    console.log('📌 Policy: STRICTLY ONLY replies to messages (DMs).');
    console.log('==================================================');

    botStats.status = 'connecting';
    botStats.error = null;

    ig = await igManager.login(customUsername, customPassword);
    const currentUser = await ig.account.currentUser();
    botUserId = currentUser.pk;

    console.log(`🤖 Bot Active! Listening to DMs for @${currentUser.username} (ID: ${botUserId})`);
    botStats.status = 'active';

    if (!pollingTimer) {
      pollingTimer = setInterval(pollInbox, POLL_INTERVAL);
    }
    pollInbox();
    return true;
  } catch (err) {
    console.error('💥 Initialization error:', err.message);
    botStats.status = 'error';
    botStats.error = err.message;
    return false;
  }
}

// Express App
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve HTML Dashboard
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📸 Insta-Bot | Smart DM Auto-Reply</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0a0a0f;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
    padding: 20px 15px;
    background-image: radial-gradient(circle at 10% 20%, rgba(131, 58, 180, 0.15) 0%, transparent 40%),
                      radial-gradient(circle at 90% 80%, rgba(253, 29, 29, 0.12) 0%, transparent 40%);
  }
  .container { max-width: 800px; margin: 0 auto; }
  header {
    text-align: center;
    padding: 20px 0 25px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 25px;
  }
  h1 {
    font-size: 28px;
    font-weight: 800;
    background: linear-gradient(135deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
  }
  .subtitle { color: #94a3b8; font-size: 14px; margin-top: 6px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
  .card {
    background: rgba(18, 18, 26, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 22px;
    backdrop-filter: blur(12px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }
  h2 { font-size: 16px; font-weight: 700; color: #f8fafc; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; }
  .status-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .badge {
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge-active { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
  .badge-connecting { background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); }
  .badge-error { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
  .badge-idle { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 15px; }
  .stat-box { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05); padding: 12px; border-radius: 10px; text-align: center; }
  .stat-val { font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 2px; }
  .stat-lbl { font-size: 11px; color: #64748b; text-transform: uppercase; }
  input {
    width: 100%;
    background: rgba(10, 10, 15, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    padding: 12px 14px;
    color: #fff;
    font-size: 14px;
    margin-bottom: 12px;
    outline: none;
    transition: all 0.2s;
  }
  input:focus { border-color: #e6683c; box-shadow: 0 0 10px rgba(230, 104, 60, 0.25); }
  button {
    width: 100%;
    padding: 12px 16px;
    border-radius: 10px;
    border: none;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
    background: linear-gradient(135deg, #f09433, #dc2743, #bc1888);
    color: white;
  }
  button:hover { opacity: 0.92; transform: translateY(-1px); }
  button.btn-secondary {
    background: rgba(255, 255, 255, 0.08);
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  .otp-box {
    margin-top: 15px;
    padding: 16px;
    background: rgba(234, 179, 8, 0.1);
    border: 1px solid rgba(234, 179, 8, 0.3);
    border-radius: 12px;
    display: none;
  }
  .otp-box.active { display: block; }
  .messages-list { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; max-height: 400px; overflow-y: auto; }
  .msg-item {
    background: rgba(255, 255, 255, 0.03);
    border-left: 3px solid #dc2743;
    border-radius: 8px;
    padding: 12px 14px;
    font-size: 13px;
  }
  .msg-header { display: flex; justify-content: space-between; color: #94a3b8; font-size: 12px; margin-bottom: 4px; }
  .msg-user { font-weight: 700; color: #f87171; }
  .msg-incoming { color: #f1f5f9; margin-bottom: 6px; }
  .msg-reply { color: #4ade80; background: rgba(34, 197, 94, 0.08); padding: 6px 10px; border-radius: 6px; }
  .notice {
    font-size: 12px;
    color: #94a3b8;
    background: rgba(255, 255, 255, 0.03);
    padding: 10px;
    border-radius: 8px;
    margin-top: 10px;
    text-align: center;
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>📸 Insta-Bot</h1>
    <p class="subtitle">AI-Powered Instagram DM Auto-Reply • Turso Cloud Database</p>
  </header>

  <div class="grid">
    <!-- Status Card -->
    <div class="card">
      <div class="status-row">
        <h2>⚡ Bot Status</h2>
        <span id="botBadge" class="badge badge-idle">Checking...</span>
      </div>
      <div id="accountInfo" style="font-size: 14px; color: #cbd5e1; margin-bottom: 10px;">
        Account: <strong id="igUser">Not Connected</strong>
      </div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-val" id="statReplies">0</div>
          <div class="stat-lbl">Replies Sent</div>
        </div>
        <div class="stat-box">
          <div class="stat-val" id="statCached">0</div>
          <div class="stat-lbl">Cached Msgs</div>
        </div>
        <div class="stat-box">
          <div class="stat-val" id="statDb">Connected</div>
          <div class="stat-lbl">Turso DB</div>
        </div>
      </div>
      <div style="margin-top: 15px; display: flex; gap: 10px;">
        <button id="toggleBtn" class="btn-secondary" onclick="toggleBot()">Pause Bot</button>
      </div>
    </div>

    <!-- Login / Connect Card -->
    <div class="card" id="loginCard">
      <h2>🔐 Connect Instagram Account</h2>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 12px;">Enter your credentials to link your Instagram account. Credentials are saved only to your private .env and Turso DB.</p>
      <input type="text" id="usernameInput" placeholder="Instagram Username" />
      <input type="password" id="passwordInput" placeholder="Instagram Password" />
      <button onclick="connectAccount()">Connect & Start Bot</button>

      <!-- OTP Modal / Box -->
      <div class="otp-box" id="otpBox">
        <p style="color: #facc15; font-size: 13px; font-weight: 600; margin-bottom: 8px;" id="otpPrompt">
          📩 OTP verification code requested!
        </p>
        <input type="text" id="otpCodeInput" placeholder="Enter 6-digit OTP code" />
        <button onclick="submitOtp()">Submit OTP</button>
      </div>
    </div>

    <!-- Recent Messages Card -->
    <div class="card">
      <h2>💬 Recent Auto-Replied DMs</h2>
      <div class="messages-list" id="messagesList">
        <p style="color: #64748b; font-size: 13px; text-align: center; padding: 20px;">No messages received yet.</p>
      </div>
    </div>

    <div class="notice">
      🔒 <strong>Policy Note:</strong> This bot strictly replies to incoming text messages only. It will never like, comment, view stories or follow/unfollow users.
    </div>
  </div>
</div>

<script>
async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    
    const badge = document.getElementById('botBadge');
    badge.className = 'badge';
    if (data.status === 'active') {
      badge.textContent = 'Online & Active';
      badge.classList.add('badge-active');
    } else if (data.status === 'connecting') {
      badge.textContent = 'Connecting...';
      badge.classList.add('badge-connecting');
    } else if (data.status === 'error') {
      badge.textContent = 'Error: ' + (data.error || 'Check credentials');
      badge.classList.add('badge-error');
    } else {
      badge.textContent = 'Idle';
      badge.classList.add('badge-idle');
    }

    document.getElementById('igUser').textContent = data.account ? '@' + data.account : 'Not Connected';
    document.getElementById('statReplies').textContent = data.totalReplies || 0;
    document.getElementById('statCached').textContent = data.cachedIds || 0;

    const toggleBtn = document.getElementById('toggleBtn');
    toggleBtn.textContent = data.botActive ? 'Pause Bot' : 'Resume Bot';

    const otpBox = document.getElementById('otpBox');
    if (data.pendingOtp) {
      otpBox.classList.add('active');
      document.getElementById('otpPrompt').textContent = '📩 ' + data.pendingOtp.prompt;
    } else {
      otpBox.classList.remove('active');
    }
  } catch(e) {}
}

async function refreshMessages() {
  try {
    const res = await fetch('/api/messages');
    const msgs = await res.json();
    const list = document.getElementById('messagesList');
    if (!msgs || msgs.length === 0) {
      list.innerHTML = '<p style="color: #64748b; font-size: 13px; text-align: center; padding: 20px;">No messages received yet.</p>';
      return;
    }
    list.innerHTML = msgs.map(m => \`
      <div class="msg-item">
        <div class="msg-header">
          <span class="msg-user">@\${m.sender_username || 'user'}</span>
          <span>\${m.created_at || ''} (\${m.source || 'ai'})</span>
        </div>
        <div class="msg-incoming">📩 \${m.incoming_text}</div>
        <div class="msg-reply">🤖 \${m.reply_text}</div>
      </div>
    \`).join('');
  } catch(e) {}
}

async function connectAccount() {
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value.trim();
  if (!username || !password) {
    alert('Please enter username and password');
    return;
  }
  const res = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  refreshStatus();
}

async function submitOtp() {
  const code = document.getElementById('otpCodeInput').value.trim();
  if (!code) {
    alert('Please enter OTP code');
    return;
  }
  const res = await fetch('/api/submit-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  document.getElementById('otpCodeInput').value = '';
  refreshStatus();
}

async function toggleBot() {
  await fetch('/api/toggle', { method: 'POST' });
  refreshStatus();
}

setInterval(refreshStatus, 4000);
setInterval(refreshMessages, 6000);
refreshStatus();
refreshMessages();
</script>
</body>
</html>`);
});

// JSON API Endpoints
app.get('/api/status', async (req, res) => {
  const dbStats = await db.getStats();
  const pendingOtp = igManager.isOtpPending();
  res.json({
    status: botStats.status,
    botActive,
    account: igManager.currentUser ? igManager.currentUser.username : null,
    totalReplies: dbStats.totalReplies,
    cachedIds: dbStats.cachedIds,
    pendingOtp,
    error: botStats.error,
  });
});

app.get('/api/messages', async (req, res) => {
  const messages = await db.getRecentMessages(25);
  res.json(messages);
});

app.post('/api/connect', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  // Start login in background
  startBot(username, password);
  res.json({ success: true, message: 'Login started' });
});

app.post('/api/submit-otp', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Code required' });
  }
  const submitted = igManager.submitOtp(code);
  res.json({ success: submitted });
});

app.post('/api/toggle', (req, res) => {
  botActive = !botActive;
  res.json({ botActive });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🌐 Insta-Bot Dashboard running at http://localhost:${PORT}`);
  await db.init();
  // Auto-connect if credentials already in .env
  if (process.env.IG_USERNAME && process.env.IG_PASSWORD) {
    startBot();
  } else {
    console.log('ℹ️ Waiting for credentials from Web Dashboard or .env file...');
    botStats.status = 'idle';
  }
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
