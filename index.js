require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const igManager = require('./lib/igClient');
const replyEngine = require('./lib/replyEngine');
const db = require('./lib/db');
const creds = require('./lib/creds');
const adminRouter = require('./lib/adminRouter');

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
  const isBotActive = (await db.getSetting('bot_active', 'true')) === 'true';
  if (!isBotActive) return;
  const isAutoReply = (await db.getSetting('auto_reply_enabled', 'true')) === 'true';
  if (!isAutoReply) return;
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

      // Record in Turso DB (includes multi-turn memory + lead extraction)
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
      console.log(`ℹ️ [Ignored] No matching rule or user blocked.`);
    }
  } catch (err) {
    console.error(`❌ [Error replying to @${senderUsername}]:`, err.message);
  }
}

async function pollInbox() {
  const isBotActive = (await db.getSetting('bot_active', 'true')) === 'true';
  if (!isBotActive || isPolling || !ig || !igManager.isLoggedIn) return;
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
app.use(adminRouter);
if (typeof adminRouter.setStartBotHandler === 'function') {
  adminRouter.setStartBotHandler(startBot);
}

// HTML Web Dashboard
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📸 Insta-Bot | Smart Multi-Persona DM Auto-Reply</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #09090e;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
    padding: 20px 14px;
    background-image: radial-gradient(circle at 10% 20%, rgba(131, 58, 180, 0.18) 0%, transparent 40%),
                      radial-gradient(circle at 90% 80%, rgba(253, 29, 29, 0.15) 0%, transparent 40%);
  }
  .container { max-width: 900px; margin: 0 auto; }
  header {
    text-align: center;
    padding: 18px 0 22px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 20px;
  }
  h1 {
    font-size: 28px;
    font-weight: 800;
    background: linear-gradient(135deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
  }
  .subtitle { color: #94a3b8; font-size: 13px; margin-top: 6px; }

  /* Navigation Tabs */
  .nav-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    background: rgba(255, 255, 255, 0.03);
    padding: 6px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    overflow-x: auto;
  }
  .tab-btn {
    flex: 1;
    padding: 10px 14px;
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 13px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s;
  }
  .tab-btn.active {
    background: linear-gradient(135deg, rgba(230, 104, 60, 0.25), rgba(188, 24, 136, 0.25));
    color: #fff;
    border: 1px solid rgba(230, 104, 60, 0.4);
  }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .card {
    background: rgba(18, 18, 26, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 22px;
    backdrop-filter: blur(12px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    margin-bottom: 18px;
  }
  h2 { font-size: 16px; font-weight: 700; color: #f8fafc; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; }
  .status-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  
  .badge {
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-active { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
  .badge-connecting { background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); }
  .badge-error { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
  .badge-idle { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }

  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 15px; }
  @media(max-width: 600px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
  .stat-box { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05); padding: 12px; border-radius: 10px; text-align: center; }
  .stat-val { font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 2px; }
  .stat-lbl { font-size: 11px; color: #64748b; text-transform: uppercase; }

  input, select, textarea {
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
  input:focus, select:focus, textarea:focus { border-color: #e6683c; box-shadow: 0 0 10px rgba(230, 104, 60, 0.25); }

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
  button.btn-sm {
    width: auto;
    padding: 6px 12px;
    font-size: 12px;
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

  .messages-list { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; max-height: 420px; overflow-y: auto; }
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

  /* Persona Card Grid */
  .persona-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px; }
  @media(max-width: 600px) { .persona-grid { grid-template-columns: 1fr; } }
  .persona-box {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .persona-box:hover { border-color: #e6683c; background: rgba(230, 104, 60, 0.06); }
  .persona-box.selected { border-color: #e6683c; background: rgba(230, 104, 60, 0.15); box-shadow: 0 0 15px rgba(230, 104, 60, 0.2); }
  .persona-title { font-weight: 700; font-size: 15px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .persona-desc { font-size: 12px; color: #94a3b8; line-height: 1.4; }

  /* User Profiles Table */
  .user-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  .user-table th, .user-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .user-table th { color: #64748b; font-size: 11px; text-transform: uppercase; }
  .pill-vip { background: rgba(234, 179, 8, 0.15); color: #facc15; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; }
  .pill-blocked { background: rgba(239, 68, 68, 0.15); color: #f87171; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; }
  .pill-persona { background: rgba(188, 24, 136, 0.15); color: #f472b6; padding: 2px 8px; border-radius: 10px; font-size: 11px; }

  .notice { font-size: 12px; color: #94a3b8; background: rgba(255, 255, 255, 0.03); padding: 12px; border-radius: 8px; margin-top: 15px; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>📸 Insta-Bot</h1>
    <p class="subtitle">Personalized AI Instagram DM Auto-Reply • Multi-Persona • Turso Cloud Memory</p>
  </header>

  <!-- Navigation Tabs -->
  <div class="nav-tabs">
    <button class="tab-btn active" onclick="switchTab('overview')">📊 Overview & Live DMs</button>
    <button class="tab-btn" onclick="switchTab('personas')">🎭 Persona Studio (Moods)</button>
    <button class="tab-btn" onclick="switchTab('users')">👥 User Customization & Leads</button>
    <button class="tab-btn" onclick="switchTab('sender')">✉️ Manual Direct DM</button>
    <a href="/admin" class="tab-btn" style="text-decoration:none; text-align:center; background: rgba(220, 39, 67, 0.15); color: #f87171; border: 1px solid rgba(220, 39, 67, 0.3);">🛡️ Admin Portal</a>
  </div>

  <!-- TAB 1: OVERVIEW & LIVE DMS -->
  <div id="tab-overview" class="tab-content active">
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
          <div class="stat-val" id="statUsers">0</div>
          <div class="stat-lbl">Active Users</div>
        </div>
        <div class="stat-box">
          <div class="stat-val" id="statLeads">0</div>
          <div class="stat-lbl">Leads Captured</div>
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
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 12px;">Login credentials are encrypted and stored in your private .env and Turso DB.</p>
      
      <div id="savedCredsNotice" style="display: none; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; color: #6ee7b7;">
        🔒 <strong>Password Saved:</strong> Account credentials are saved. Click <em>Connect with Saved Credentials</em> to login instantly without retyping.
      </div>

      <input type="text" id="usernameInput" placeholder="Instagram Username" />
      <input type="password" id="passwordInput" placeholder="Instagram Password" />
      
      <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #cbd5e1; margin: 10px 0 14px 0; cursor: pointer;">
        <input type="checkbox" id="saveCredsCheck" checked style="width: auto; margin: 0; cursor: pointer;" />
        <span>Save credentials permanently (Auto-reconnect on restart)</span>
      </label>

      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
        <button id="connectBtn" onclick="connectAccount()" style="flex: 1;">Connect & Start Bot</button>
        <button id="clearCredsBtn" onclick="clearCredentials()" class="btn-secondary" style="display: none; background: #dc2626; border-color: #b91c1c; color: #fff;">Clear Saved Password</button>
      </div>

      <!-- OTP Modal / Box -->
      <div class="otp-box" id="otpBox">
        <p style="color: #facc15; font-size: 13px; font-weight: 600; margin-bottom: 8px;" id="otpPrompt">
          📩 OTP verification code requested!
        </p>
        <input type="text" id="otpCodeInput" placeholder="Enter 6-digit OTP code" />
        <button onclick="submitOtp()">Submit OTP Code</button>
      </div>
    </div>

    <!-- Recent Auto-Replied DMs -->
    <div class="card">
      <h2>💬 Recent Auto-Replied DMs (Live from Turso DB)</h2>
      <div class="messages-list" id="messagesList">
        <p style="color: #64748b; font-size: 13px; text-align: center; padding: 20px;">No messages received yet.</p>
      </div>
    </div>
  </div>

  <!-- TAB 2: PERSONA STUDIO -->
  <div id="tab-personas" class="tab-content">
    <div class="card">
      <h2>🎭 Choose AI Personality (Global Mood)</h2>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 16px;">
        Select how your AI assistant speaks to people in DMs by default:
      </p>

      <div class="persona-grid">
        <div class="persona-box selected" id="persona-sweet" onclick="selectPersona('sweet')">
          <div class="persona-title">🌸 AAIRA Sweet & Caring</div>
          <div class="persona-desc">Warm, feminine, sweet Hinglish assistant. Uses cute emojis, caring tone, natural chat style.</div>
        </div>
        <div class="persona-box" id="persona-business" onclick="selectPersona('business')">
          <div class="persona-title">💼 Professional & Business</div>
          <div class="persona-desc">Formal, respectful, direct. Ideal for client inquiries, collaborations, and official support.</div>
        </div>
        <div class="persona-box" id="persona-savage" onclick="selectPersona('savage')">
          <div class="persona-title">🔥 Savage Roast & Banter</div>
          <div class="persona-desc">Funny, witty, sarcastic jokes and punchlines. Great for friends and entertaining banter.</div>
        </div>
        <div class="persona-box" id="persona-casual" onclick="selectPersona('casual')">
          <div class="persona-title">🤙 Chill Bro / Buddy</div>
          <div class="persona-desc">Super relaxed, informal bro vibes. Talks like a friendly buddy hanging out.</div>
        </div>
      </div>

      <button onclick="savePersona()">Save Active Persona</button>
    </div>
  </div>

  <!-- TAB 3: USERS & LEADS -->
  <div id="tab-users" class="tab-content">
    <div class="card">
      <h2>👥 User Customization & Captured Leads</h2>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 14px;">
        Har user ke liye alag mood set karein, VIP mark karein, ya auto-captured phone numbers aur emails check karein:
      </p>

      <div style="overflow-x: auto;">
        <table class="user-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Status</th>
              <th>Persona</th>
              <th>Lead Info (Phone / Email)</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="userTableBody">
            <tr><td colspan="5" style="text-align: center; color: #64748b;">Loading user profiles...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 4: MANUAL DIRECT DM -->
  <div id="tab-sender" class="tab-content">
    <div class="card">
      <h2>✉️ Send Manual Direct Message (DM)</h2>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 14px;">
        Aap seedha is dashboard se kisi bhi Instagram user ko DM bhej sakte hain:
      </p>

      <input type="text" id="targetUserInput" placeholder="Recipient Instagram Username (without @)" />
      <textarea id="targetMessageInput" rows="3" placeholder="Type your message here..."></textarea>
      <button onclick="sendManualDm()">Send DM Now</button>
      <div id="sendResult" style="margin-top: 10px; font-size: 13px;"></div>
    </div>
  </div>

  <div class="notice">
    🔒 <strong>Strict Policy:</strong> Bot strictly operates on Direct Messages only. No follow, like, or story viewing actions.
  </div>
</div>

<script>
let currentGlobalPersona = 'sweet';

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tabId).classList.add('active');
  event.target.classList.add('active');

  if (tabId === 'users') loadProfiles();
}

function selectPersona(type) {
  currentGlobalPersona = type;
  document.querySelectorAll('.persona-box').forEach(b => b.classList.remove('selected'));
  document.getElementById('persona-' + type).classList.add('selected');
}

async function savePersona() {
  await fetch('/api/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: currentGlobalPersona })
  });
  alert('Active persona updated to: ' + currentGlobalPersona);
}

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
    document.getElementById('statUsers').textContent = data.totalUsers || 0;
    document.getElementById('statLeads').textContent = data.capturedLeads || 0;

    const toggleBtn = document.getElementById('toggleBtn');
    toggleBtn.textContent = data.botActive ? 'Pause Bot' : 'Resume Bot';

    const otpBox = document.getElementById('otpBox');
    if (data.pendingOtp) {
      otpBox.classList.add('active');
      document.getElementById('otpPrompt').textContent = '📩 ' + data.pendingOtp.prompt;
    } else {
      otpBox.classList.remove('active');
    }

    if (data.globalPersona) {
      selectPersona(data.globalPersona);
    }

    // Credentials status & prefill
    if (data.savedUsername) {
      const uInput = document.getElementById('usernameInput');
      if (uInput && !uInput.value) {
        uInput.value = data.savedUsername;
      }
    }

    const pInput = document.getElementById('passwordInput');
    const notice = document.getElementById('savedCredsNotice');
    const clearBtn = document.getElementById('clearCredsBtn');
    const connBtn = document.getElementById('connectBtn');

    if (data.hasSavedPassword) {
      hasSavedCredentials = true;
      if (notice) notice.style.display = 'block';
      if (clearBtn) clearBtn.style.display = 'inline-block';
      if (pInput && !pInput.value) {
        pInput.placeholder = '•••••••• (Password Saved - leave blank to use saved)';
      }
      if (connBtn && (!pInput || !pInput.value.trim())) {
        connBtn.textContent = '⚡ Connect with Saved Credentials';
      }
    } else {
      hasSavedCredentials = false;
      if (notice) notice.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'none';
      if (connBtn && (!pInput || !pInput.value.trim())) {
        connBtn.textContent = 'Connect & Start Bot';
      }
      if (pInput && !pInput.value) {
        pInput.placeholder = 'Instagram Password';
      }
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

async function loadProfiles() {
  try {
    const res = await fetch('/api/profiles');
    const profiles = await res.json();
    const tbody = document.getElementById('userTableBody');
    if (!profiles || profiles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 20px;">No user profiles yet. Once people DM you, they will appear here!</td></tr>';
      return;
    }
    tbody.innerHTML = profiles.map(p => \`
      <tr>
        <td><strong>@\${p.username}</strong> \${p.custom_name ? '(\' + p.custom_name + \')' : ''}</td>
        <td>
          \${p.is_vip ? '<span class="pill-vip">⭐ VIP</span> ' : ''}
          \${p.is_blocked ? '<span class="pill-blocked">🚫 Blocked</span>' : '<span style="color:#4ade80;">Active</span>'}
        </td>
        <td><span class="pill-persona">\${p.persona || 'default'}</span></td>
        <td>
          \${p.lead_phone ? '📱 ' + p.lead_phone + '<br>' : ''}
          \${p.lead_email ? '✉️ ' + p.lead_email : ''}
          \${(!p.lead_phone && !p.lead_email) ? '<span style="color:#64748b;">No lead captured</span>' : ''}
        </td>
        <td>
          <button class="btn-secondary btn-sm" onclick="toggleVip('\${p.username}', \${p.is_vip ? 0 : 1})">\${p.is_vip ? 'Remove VIP' : 'Make VIP'}</button>
          <button class="btn-secondary btn-sm" onclick="toggleBlock('\${p.username}', \${p.is_blocked ? 0 : 1})">\${p.is_blocked ? 'Unblock' : 'Block'}</button>
          <button class="btn-secondary btn-sm" onclick="setCustomPersona('\${p.username}')">Set Mood</button>
        </td>
      </tr>
    \`).join('');
  } catch(e) {}
}

async function toggleVip(username, is_vip) {
  await fetch('/api/profiles/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, is_vip })
  });
  loadProfiles();
}

async function toggleBlock(username, is_blocked) {
  await fetch('/api/profiles/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, is_blocked })
  });
  loadProfiles();
}

async function setCustomPersona(username) {
  const persona = prompt('Enter custom mood for @' + username + ' (sweet / business / savage / casual):', 'savage');
  if (persona) {
    await fetch('/api/profiles/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, persona: persona.toLowerCase().trim() })
    });
    loadProfiles();
  }
}

async function sendManualDm() {
  const username = document.getElementById('targetUserInput').value.trim();
  const text = document.getElementById('targetMessageInput').value.trim();
  const resDiv = document.getElementById('sendResult');

  if (!username || !text) {
    alert('Please enter username and message');
    return;
  }

  resDiv.style.color = '#facc15';
  resDiv.textContent = 'Sending message to @' + username + '...';

  try {
    const res = await fetch('/api/send-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, text })
    });
    const data = await res.json();
    if (data.success) {
      resDiv.style.color = '#4ade80';
      resDiv.textContent = '✅ Message sent successfully!';
      document.getElementById('targetMessageInput').value = '';
      refreshMessages();
    } else {
      resDiv.style.color = '#f87171';
      resDiv.textContent = '❌ ' + (data.error || 'Failed to send message');
    }
  } catch(e) {
    resDiv.style.color = '#f87171';
    resDiv.textContent = '❌ Error: ' + e.message;
  }
}

let hasSavedCredentials = false;

async function connectAccount() {
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value.trim();
  const saveCheck = document.getElementById('saveCredsCheck');
  const saveCredentials = saveCheck ? saveCheck.checked : true;

  if (!username && !hasSavedCredentials) {
    alert('Please enter your Instagram username');
    return;
  }
  if (!password && !hasSavedCredentials) {
    alert('Please enter your Instagram password');
    return;
  }

  const btn = document.getElementById('connectBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Connecting...';
  }

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, saveCredentials })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Connection failed');
    }
  } catch (err) {
    alert('Connection error: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
    refreshStatus();
  }
}

async function clearCredentials() {
  if (!confirm('Are you sure you want to remove the saved Instagram credentials?')) return;
  try {
    await fetch('/api/credentials/clear', { method: 'POST' });
    document.getElementById('usernameInput').value = '';
    document.getElementById('passwordInput').value = '';
    document.getElementById('passwordInput').placeholder = 'Instagram Password';
    const notice = document.getElementById('savedCredsNotice');
    if (notice) notice.style.display = 'none';
    const clearBtn = document.getElementById('clearCredsBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    const connBtn = document.getElementById('connectBtn');
    if (connBtn) connBtn.textContent = 'Connect & Start Bot';
    hasSavedCredentials = false;
    alert('Saved credentials removed!');
  } catch (err) {
    alert('Error clearing credentials: ' + err.message);
  }
  refreshStatus();
}

const passInputElem = document.getElementById('passwordInput');
if (passInputElem) {
  passInputElem.addEventListener('input', (e) => {
    const connBtn = document.getElementById('connectBtn');
    if (connBtn) {
      if (e.target.value.trim().length > 0) {
        connBtn.textContent = hasSavedCredentials ? 'Connect & Update Password' : 'Connect & Start Bot';
      } else if (hasSavedCredentials) {
        connBtn.textContent = '⚡ Connect with Saved Credentials';
      }
    }
  });
}

async function submitOtp() {
  const code = document.getElementById('otpCodeInput').value.trim();
  if (!code) {
    alert('Please enter OTP code');
    return;
  }
  await fetch('/api/submit-otp', {
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
  const globalPersona = await db.getSetting('global_persona', 'sweet');
  const credInfo = await creds.getCredentials();
  const isBotActive = (await db.getSetting('bot_active', 'true')) === 'true';
  const autoReplyEnabled = (await db.getSetting('auto_reply_enabled', 'true')) === 'true';
  const groqAiEnabled = (await db.getSetting('groq_ai_enabled', 'true')) === 'true';
  const savedModelEnabled = (await db.getSetting('saved_model_enabled', 'true')) === 'true';

  res.json({
    status: botStats.status,
    botActive: isBotActive,
    autoReplyEnabled,
    groqAiEnabled,
    savedModelEnabled,
    account: igManager.currentUser ? igManager.currentUser.username : (credInfo.username || null),
    savedUsername: credInfo.username,
    hasSavedPassword: credInfo.hasSavedPassword,
    totalReplies: dbStats.totalReplies,
    totalUsers: dbStats.totalUsers,
    capturedLeads: dbStats.capturedLeads,
    cachedIds: dbStats.cachedIds,
    globalPersona,
    pendingOtp,
    error: botStats.error,
  });
});

app.get('/api/messages', async (req, res) => {
  const messages = await db.getRecentMessages(25);
  res.json(messages);
});

app.get('/api/profiles', async (req, res) => {
  const profiles = await db.getAllProfiles();
  res.json(profiles);
});

app.post('/api/profiles/update', async (req, res) => {
  const { username, ...data } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  await db.updateUserProfile(username, data);
  res.json({ success: true });
});

app.post('/api/persona', async (req, res) => {
  const { persona } = req.body;
  if (!persona) return res.status(400).json({ error: 'Persona required' });
  await db.setSetting('global_persona', persona);
  res.json({ success: true, persona });
});

app.post('/api/connect', async (req, res) => {
  let { username, password, saveCredentials = true } = req.body;
  const credInfo = await creds.getCredentials();

  if (!username) username = credInfo.username;
  if (!password) password = credInfo.password;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (saveCredentials) {
    await creds.saveCredentials(username, password);
  }

  startBot(username, password);
  res.json({ success: true, message: 'Login started', saved: Boolean(saveCredentials) });
});

app.post('/api/credentials/clear', async (req, res) => {
  try {
    await creds.clearCredentials();
    botStats.status = 'idle';
    botStats.error = null;
    res.json({ success: true, message: 'Saved credentials removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submit-otp', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Code required' });
  }
  const submitted = igManager.submitOtp(code);
  res.json({ success: submitted });
});

app.post('/api/toggle', async (req, res) => {
  const current = (await db.getSetting('bot_active', 'true')) === 'true';
  const next = !current;
  await db.setSetting('bot_active', String(next));
  botActive = next;
  res.json({ botActive: next });
});

app.post('/api/setting/toggle', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  const current = (await db.getSetting(key, 'true')) === 'true';
  const next = !current;
  await db.setSetting(key, String(next));
  res.json({ success: true, key, value: next });
});

// Manual direct DM sender
app.post('/api/send-direct', async (req, res) => {
  const { username, text } = req.body;
  if (!username || !text) {
    return res.status(400).json({ error: 'Recipient username and message text required' });
  }
  if (!ig || !igManager.isLoggedIn) {
    return res.status(400).json({ error: 'Instagram bot is not logged in' });
  }

  try {
    const cleanUser = username.replace(/^@/, '').trim();
    const user = await ig.user.searchExact(cleanUser);
    if (!user || !user.pk) {
      return res.status(404).json({ error: `Instagram user @${cleanUser} not found` });
    }

    const thread = ig.entity.directThread([String(user.pk)]);
    await thread.broadcastText(text);

    // Record to Turso DB
    await db.recordProcessedMessage({
      itemId: 'manual_' + Date.now(),
      threadId: 'manual',
      senderId: user.pk,
      senderUsername: cleanUser,
      incomingText: '(Manual Web Direct)',
      replyText: text,
      source: 'manual-web'
    });

    res.json({ success: true, user: cleanUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`🌐 Insta-Bot Dashboard running at http://localhost:${PORT}`);
  await db.init();

  // Auto-connect: check .env and Turso DB
  const credInfo = await creds.getCredentials();
  if (credInfo.username && credInfo.password) {
    console.log(`🔄 Auto-connecting saved Instagram account: @${credInfo.username}...`);
    startBot(credInfo.username, credInfo.password);
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
