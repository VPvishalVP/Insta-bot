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
let pendingSaveCredentials = null;

let botStats = {
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  status: 'idle',
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

    // If pendingSaveCredentials matches this user, persist now that login succeeded!
    if (pendingSaveCredentials && pendingSaveCredentials.username === customUsername) {
      await creds.saveCredentials(pendingSaveCredentials.username, pendingSaveCredentials.password);
      console.log(`✅ [Creds] Instagram credentials verified & saved permanently for @${customUsername}`);
      pendingSaveCredentials = null;
    }

    if (!pollingTimer) {
      pollingTimer = setInterval(pollInbox, POLL_INTERVAL);
    }
    pollInbox();
    return true;
  } catch (err) {
    console.error('💥 Initialization error:', err.message);
    botStats.status = 'error';
    botStats.error = err.message;
    pendingSaveCredentials = null;
    return false;
  }
}

// Express App
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve background image asset
app.get('/anime-bg.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'anime-bg.jpg'));
});

// Admin portal router
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
<title>VIHUHUHU KA AAIRA BOT (INSTAGRAM)</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    color: #f5f5f5;
    font-family: 'Trebuchet MS', 'Segoe UI', Arial, sans-serif;
    background: linear-gradient(rgba(0,0,0,.38), rgba(0,0,0,.52)),
                url('/anime-bg.jpg') center center / cover fixed,
                radial-gradient(ellipse at top, #3b3b3b 0, #090909 48%, #000 100%);
    background-color: #050505;
  }
  body:before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(110deg, transparent 35%, rgba(255,255,255,.04) 50%, transparent 65%);
  }

  .wrap {
    width: min(960px, 94%);
    margin: 25px auto;
  }

  /* Metallic Glowing Headers */
  .logo {
    font-size: 34px;
    font-weight: 900;
    letter-spacing: 5px;
    text-shadow: 0 0 18px #ddd;
    background: linear-gradient(110deg, #ffffff 0%, #d8d8d8 38%, #8e8e8e 68%, #ffffff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  h1, h2, h3 {
    margin: 0 0 10px;
    font-weight: 900;
    letter-spacing: 2px;
    text-transform: uppercase;
    background: linear-gradient(110deg, #ffffff 0%, #d8d8d8 38%, #8e8e8e 68%, #ffffff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-shadow: 0 0 16px rgba(255, 255, 255, 0.25);
  }
  .subtitle {
    color: #aaa;
    letter-spacing: 2px;
    font-size: 13px;
    margin-top: 6px;
    font-weight: 600;
  }

  /* Metallic Glassmorphism Panel */
  .panel {
    background: linear-gradient(145deg, rgba(8,8,8,.75), rgba(22,22,22,.68));
    border: 1px solid #555555;
    border-radius: 18px;
    padding: 22px;
    margin: 16px 0;
    box-shadow: 0 8px 28px #0009, 0 0 14px rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(12px);
    transition: border-color .2s;
  }
  .panel:hover {
    border-color: #c8c8c8;
  }

  /* Form Elements */
  input, select, textarea {
    width: 100%;
    background: rgba(5,5,5,.75);
    color: white;
    border: 1px solid #666;
    border-radius: 10px;
    padding: 13px;
    margin: 6px 0 12px;
    font-size: 14px;
    outline: none;
    font-family: inherit;
    transition: border-color .2s, box-shadow .2s;
  }
  input:focus, select:focus, textarea:focus {
    border-color: #eee;
    box-shadow: 0 0 10px #777;
  }

  /* Buttons */
  button {
    background: linear-gradient(135deg, #3d3d3d, #080808);
    color: #fff;
    border: 1px solid #aaa;
    border-radius: 10px;
    padding: 12px 16px;
    margin: 4px;
    cursor: pointer;
    font-weight: bold;
    font-family: inherit;
    transition: transform .15s, border-color .15s, background .15s, color .15s;
  }
  button:hover {
    transform: translateY(-1px);
    border-color: #f2f2f2;
    background: linear-gradient(135deg, #777777, #202020);
    color: #fff;
    box-shadow: 0 0 14px #aaa;
  }
  button:disabled {
    opacity: .45;
    cursor: not-allowed;
    transform: none !important;
  }

  /* Pills */
  .pill {
    display: inline-block;
    border: 1px solid #777;
    border-radius: 30px;
    padding: 5px 14px;
    font-size: 12px;
    font-weight: bold;
    text-transform: uppercase;
  }
  .pill.green {
    color: #6ee7b7;
    border-color: #10b981;
    background: rgba(16,185,129,0.18);
  }
  .pill.red {
    color: #fca5a5;
    border-color: #ef4444;
    background: rgba(239,68,68,0.18);
  }
  .pill.yellow {
    color: #fde047;
    border-color: #eab308;
    background: rgba(234,179,8,0.18);
  }

  /* Navigation Tabs */
  .nav-tabs {
    display: flex;
    gap: 8px;
    margin: 18px 0;
    background: rgba(10, 10, 10, 0.7);
    padding: 6px;
    border-radius: 14px;
    border: 1px solid #555;
    overflow-x: auto;
  }
  .tab-btn {
    flex: 1;
    padding: 11px 16px;
    background: transparent;
    border: 1px solid transparent;
    color: #bbb;
    font-size: 13px;
    font-weight: 700;
    border-radius: 10px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s;
    font-family: inherit;
    margin: 0;
  }
  .tab-btn:hover {
    color: #fff;
    border-color: #777;
  }
  .tab-btn.active {
    background: linear-gradient(135deg, #444, #111);
    color: #fff;
    border: 1px solid #aaa;
    box-shadow: 0 0 12px rgba(255,255,255,0.15);
  }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Persona Card Grid */
  .persona-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 16px;
  }
  @media(max-width: 600px) {
    .persona-grid { grid-template-columns: 1fr; }
  }
  .persona-box {
    background: rgba(10, 10, 10, 0.6);
    border: 1px solid #444;
    border-radius: 14px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .persona-box:hover {
    border-color: #aaa;
    background: rgba(40, 40, 40, 0.4);
  }
  .persona-box.selected {
    border-color: #6ee7b7;
    background: rgba(16, 185, 129, 0.12);
    box-shadow: 0 0 16px rgba(16, 185, 129, 0.2);
  }
  .persona-title {
    font-weight: 700;
    font-size: 15px;
    margin-bottom: 4px;
    color: #fff;
  }
  .persona-desc {
    font-size: 12px;
    color: #94a3b8;
    line-height: 1.4;
  }

  /* Table */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-top: 10px;
  }
  th, td {
    padding: 12px 14px;
    text-align: left;
    border-bottom: 1px solid #333;
  }
  th {
    color: #bbb;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  tr:hover { background: rgba(255, 255, 255, 0.03); }

  /* Chat item */
  .msg-item {
    background: rgba(10, 10, 10, 0.7);
    border: 1px solid #444;
    border-left: 3px solid #10b981;
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 10px;
    font-size: 13px;
  }
  .msg-header {
    display: flex;
    justify-content: space-between;
    color: #888;
    font-size: 11px;
    margin-bottom: 6px;
  }
  .msg-incoming { color: #f1f5f9; margin-bottom: 6px; }
  .msg-reply {
    color: #6ee7b7;
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.25);
    padding: 8px 12px;
    border-radius: 8px;
    white-space: pre-wrap;
  }
</style>
</head>
<body>

<!-- ═══════════════════════════════════════════════════════════ -->
<!-- 1. LOGIN GATE: STRICTLY LOCKED UNTIL VALID INSTAGRAM LOGIN   -->
<!-- ═══════════════════════════════════════════════════════════ -->
<section id="loginGate" style="min-height: 90vh; display: flex; align-items: center; justify-content: center; padding: 20px;">
  <div class="panel" style="width: min(460px, 100%); margin: 0; text-align: center;">
    <div class="logo" style="font-size: 30px; letter-spacing: 3px;">VIHUHUHU KA</div>
    <h2 style="font-size: 24px; margin: 10px 0 6px;">✦ AAIRA BOT (INSTAGRAM) ✦</h2>
    <p style="font-size: 13px; color: #aaa; margin: 0 0 20px; letter-spacing: 1px;">
      WELCOME TO AAIRA INSTAGRAM DM BOT
    </p>

    <div style="border-top: 1px solid #444; padding-top: 18px; text-align: left;">
      <h3 style="font-size: 15px; margin-bottom: 8px;">🔐 INSTAGRAM ACCOUNT LOGIN</h3>
      <p style="font-size: 12px; color: #999; line-height: 1.5; margin-bottom: 16px;">
        Instagram username aur password enter karein. Instagram par live login verify hone ke baad hi dashboard khulega aur credentials database me save honge.
      </p>

      <div id="savedCredsBanner" style="display: none; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 12px; color: #6ee7b7;">
        🔒 <strong>Saved Credentials Found:</strong> Previous verified credentials loaded. Click <em>LOGIN & UNLOCK DASHBOARD</em> to reconnect.
      </div>

      <label style="font-size: 12px; color: #ddd; font-weight: bold;">Instagram Username</label>
      <input type="text" id="gateUser" placeholder="Instagram Username (e.g. your_handle)" autocomplete="username" />

      <label style="font-size: 12px; color: #ddd; font-weight: bold; margin-top: 4px; display: block;">Instagram Password</label>
      <div style="display: flex; gap: 6px; align-items: center;">
        <input type="password" id="gatePass" placeholder="Instagram Password" autocomplete="current-password" style="margin: 6px 0 12px; flex: 1;" />
        <button type="button" onclick="togglePassVisibility('gatePass')" style="padding: 12px 14px; margin: 6px 0 12px;" title="Show/Hide Password">👁️</button>
      </div>

      <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #cbd5e1; margin: 4px 0 16px; cursor: pointer;">
        <input type="checkbox" id="gateSaveCreds" checked style="width: auto; margin: 0; cursor: pointer;" />
        <span>Save credentials in database & .env permanently</span>
      </label>

      <button type="button" id="gateLoginBtn" onclick="doGateLogin()" style="width: 100%; margin: 4px 0; padding: 14px; font-size: 15px; letter-spacing: 1px;">
        🚀 LOGIN & UNLOCK DASHBOARD
      </button>

      <div id="gateError" style="display: none; background: rgba(220,38,38,0.2); border: 1px solid #ef4444; border-radius: 10px; padding: 12px; margin-top: 14px; color: #fca5a5; font-size: 13px; line-height: 1.5;"></div>

      <!-- OTP Challenge Box -->
      <div id="gateOtpBox" style="display: none; background: rgba(234,179,8,0.15); border: 1px solid #eab308; border-radius: 12px; padding: 16px; margin-top: 16px;">
        <p style="color: #fde047; font-size: 13px; font-weight: bold; margin-bottom: 8px;" id="gateOtpPrompt">
          📩 OTP verification code requested by Instagram!
        </p>
        <input type="text" id="gateOtpCode" placeholder="Enter 6-digit OTP code" style="margin-bottom: 10px;" />
        <button type="button" onclick="submitGateOtp()" style="width: 100%;">SUBMIT OTP CODE</button>
      </div>

      <div style="margin-top: 20px; text-align: center;">
        <a href="/admin" style="color: #888; font-size: 12px; text-decoration: none; border-bottom: 1px dashed #555; padding-bottom: 2px;">
          🛡️ Owner Admin Portal Login →
        </a>
      </div>
    </div>
  </div>
</section>

<!-- ═══════════════════════════════════════════════════════════ -->
<!-- 2. MAIN DASHBOARD: UNLOCKED ONLY AFTER SUCCESSFUL LOGIN     -->
<!-- ═══════════════════════════════════════════════════════════ -->
<div id="dashboardWrap" class="wrap" style="display: none;">
  <!-- Header -->
  <header style="text-align: center; padding: 20px 10px 10px;">
    <div class="logo">VIHUHUHU KA</div>
    <h1 style="font-size: 28px; margin: 10px 0 6px;">✦ AAIRA BOT (INSTAGRAM) ✦</h1>
    <div class="subtitle">VIHUHUHU KA INSTAGRAM DM ASSISTANT</div>
    <div style="max-width: 480px; margin: 16px auto 0; display: flex; gap: 8px; flex-wrap: wrap;">
      <a href="/admin" role="button" style="flex: 1; text-align: center; text-decoration: none; background: rgba(25, 20, 20, 0.7); color: #f87171; border: 1px solid #7f1d1d; border-radius: 10px; padding: 11px 14px; font-weight: bold; font-size: 13px;">🛡️ ADMIN PORTAL</a>
      <button type="button" onclick="disconnectAccount()" style="flex: 1; margin: 0; background: rgba(40,10,10,0.6); border-color: #7f1d1d; color: #fca5a5; font-size: 13px;">🚪 DISCONNECT INSTAGRAM</button>
    </div>
  </header>

  <!-- Panel: Instagram Connection & Bot Controls (Identical Parity to wa-bot) -->
  <section class="panel">
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
      <h2 style="margin: 0; font-size: 17px;">INSTAGRAM CONNECTION</h2>
      <span id="connectionPill" class="pill green">Connected ✅</span>
    </div>

    <div id="accountInfoBox" style="margin-top: 14px; background: rgba(10,10,10,0.7); padding: 14px; border-radius: 12px; border-left: 3px solid #10b981;">
      <div style="font-size: 15px; color: #6ee7b7; font-weight: bold;" id="igAccountName">@loading...</div>
      <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;" id="igAccountMeta">Strictly listening and replying to incoming Direct Messages (DMs)</div>
    </div>

    <!-- Status rows with pills -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px;">
      <span>Bot Status</span>
      <span id="botStatusPill" class="pill green">Active</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
      <span>Auto Reply</span>
      <span id="autoReplyPill" class="pill green">Active</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
      <span>Groq AI Engine</span>
      <span id="groqAiPill" class="pill green">Active</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
      <span>Saved Rules Engine</span>
      <span id="savedRulesPill" class="pill green">Active</span>
    </div>

    <!-- Quick action buttons -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 18px;">
      <button type="button" onclick="setSetting('bot_active', true)">BOT ON</button>
      <button type="button" onclick="setSetting('bot_active', false)">BOT OFF</button>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
      <button type="button" onclick="setSetting('auto_reply_enabled', true)">AUTO-REPLY ON</button>
      <button type="button" onclick="setSetting('auto_reply_enabled', false)">AUTO-REPLY OFF</button>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
      <button type="button" onclick="setSetting('groq_ai_enabled', true)">GROQ AI ON</button>
      <button type="button" onclick="setSetting('groq_ai_enabled', false)">GROQ AI OFF</button>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
      <button type="button" onclick="setSetting('saved_model_enabled', true)">SAVED RULES ON</button>
      <button type="button" onclick="setSetting('saved_model_enabled', false)">SAVED RULES OFF</button>
    </div>
    <button onclick="refreshStatus()" style="width: 100%; margin: 8px 0 0;">↻ REFRESH STATUS</button>
  </section>

  <!-- 4 KPI Stat Boxes -->
  <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0;">
    <div class="panel" style="margin: 0; padding: 14px; text-align: center;">
      <div style="font-size: 22px; font-weight: 800; color: #fff;" id="statReplies">0</div>
      <div style="font-size: 11px; color: #aaa; text-transform: uppercase;">Replies Sent</div>
    </div>
    <div class="panel" style="margin: 0; padding: 14px; text-align: center;">
      <div style="font-size: 22px; font-weight: 800; color: #fff;" id="statUsers">0</div>
      <div style="font-size: 11px; color: #aaa; text-transform: uppercase;">Active Users</div>
    </div>
    <div class="panel" style="margin: 0; padding: 14px; text-align: center;">
      <div style="font-size: 22px; font-weight: 800; color: #fff;" id="statLeads">0</div>
      <div style="font-size: 11px; color: #aaa; text-transform: uppercase;">Leads Captured</div>
    </div>
    <div class="panel" style="margin: 0; padding: 14px; text-align: center;">
      <div style="font-size: 22px; font-weight: 800; color: #4ade80;" id="statDb">Connected</div>
      <div style="font-size: 11px; color: #aaa; text-transform: uppercase;">Turso DB</div>
    </div>
  </div>

  <!-- Navigation Tabs -->
  <div class="nav-tabs">
    <button class="tab-btn active" onclick="switchTab('overview')">💬 Live DMs Stream</button>
    <button class="tab-btn" onclick="switchTab('personas')">🎭 Persona Studio (Moods)</button>
    <button class="tab-btn" onclick="switchTab('users')">👥 User Customization & Leads</button>
    <button class="tab-btn" onclick="switchTab('sender')">✉️ Manual Direct DM</button>
  </div>

  <!-- TAB 1: LIVE DMS -->
  <div id="tab-overview" class="tab-content active">
    <div class="panel">
      <h2>💬 Recent Auto-Replied DMs (Live from Turso DB)</h2>
      <p style="font-size: 12px; color: #aaa; margin-bottom: 12px;">Direct incoming messages and intelligent AI/rule replies:</p>
      <div id="messagesList" style="max-height: 480px; overflow-y: auto;">
        <p style="color: #888; font-size: 13px; text-align: center; padding: 20px;">No messages received yet.</p>
      </div>
    </div>
  </div>

  <!-- TAB 2: PERSONA STUDIO -->
  <div id="tab-personas" class="tab-content">
    <div class="panel">
      <h2>🎭 Choose AI Personality (Global Mood)</h2>
      <p style="font-size: 13px; color: #aaa; margin-bottom: 16px;">
        Select how AAIRA speaks to users in Instagram DMs by default:
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

      <button onclick="savePersona()" style="width: 100%;">SAVE ACTIVE PERSONA</button>
    </div>
  </div>

  <!-- TAB 3: USERS & LEADS -->
  <div id="tab-users" class="tab-content">
    <div class="panel">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 14px;">
        <h2 style="margin: 0;">👥 User Customization & Captured Leads</h2>
        <button onclick="exportInstaUsersCsv()" style="padding: 8px 14px; font-size: 12px; margin: 0;">📥 Export CSV</button>
      </div>
      <p style="font-size: 12px; color: #aaa; margin-bottom: 14px;">
        Har user ke liye custom mood set karein, VIP mark karein, ya auto-captured contact numbers aur emails dekhein:
      </p>

      <div style="overflow-x: auto;">
        <table>
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
            <tr><td colspan="5" style="text-align: center; color: #888;">Loading user profiles...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 4: MANUAL DIRECT DM SENDER -->
  <div id="tab-sender" class="tab-content">
    <div class="panel">
      <h2>✉️ Send Manual Direct Message (DM)</h2>
      <p style="font-size: 12px; color: #aaa; margin-bottom: 14px;">
        Aap seedha is dashboard se kisi bhi Instagram user ko instant DM bhej sakte hain:
      </p>

      <label style="font-size: 12px; color: #ddd; font-weight: bold;">Recipient Instagram Username</label>
      <input type="text" id="targetUserInput" placeholder="Instagram username (without @)" />

      <label style="font-size: 12px; color: #ddd; font-weight: bold; margin-top: 4px; display: block;">Message Text</label>
      <textarea id="targetMessageInput" rows="3" placeholder="Type your direct message here..."></textarea>

      <button onclick="sendManualDm()" style="width: 100%;">SEND DM NOW</button>
      <div id="sendResult" style="margin-top: 12px; font-size: 13px;"></div>
    </div>
  </div>
</div>

<script>
let currentGlobalPersona = 'sweet';
let cachedUsers = [];

function togglePassVisibility(id) {
  const inp = document.getElementById(id);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('tab-' + tabId);
  if (target) target.classList.add('active');
  if (event && event.target && event.target.classList.contains('tab-btn')) {
    event.target.classList.add('active');
  }
  if (tabId === 'users') loadProfiles();
}

function selectPersona(type) {
  currentGlobalPersona = type;
  document.querySelectorAll('.persona-box').forEach(b => b.classList.remove('selected'));
  const el = document.getElementById('persona-' + type);
  if (el) el.classList.add('selected');
}

async function savePersona() {
  await fetch('/api/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: currentGlobalPersona })
  });
  alert('Active persona updated to: ' + currentGlobalPersona);
}

async function setSetting(key, value) {
  try {
    await fetch('/api/setting/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    });
    refreshStatus();
  } catch (err) {
    alert('Error updating setting: ' + err.message);
  }
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const isLoggedIn = Boolean(data.isLoggedIn || (data.status === 'active' && data.account));

    const gate = document.getElementById('loginGate');
    const dash = document.getElementById('dashboardWrap');

    if (isLoggedIn) {
      if (gate) gate.style.display = 'none';
      if (dash) dash.style.display = 'block';

      // Update Dashboard Info
      const acc = data.account ? '@' + data.account : 'Connected';
      document.getElementById('igAccountName').textContent = acc;
      document.getElementById('connectionPill').textContent = acc + ' ✅';
      document.getElementById('connectionPill').className = 'pill green';

      // Update Status Pills
      function updatePill(id, active) {
        const p = document.getElementById(id);
        if (!p) return;
        p.textContent = active ? 'Active' : 'Inactive';
        p.className = 'pill ' + (active ? 'green' : 'red');
      }
      updatePill('botStatusPill', data.botActive !== false);
      updatePill('autoReplyPill', data.autoReplyEnabled !== false);
      updatePill('groqAiPill', data.groqAiEnabled !== false);
      updatePill('savedRulesPill', data.savedModelEnabled !== false);

      // KPI Stats
      document.getElementById('statReplies').textContent = data.totalReplies || 0;
      document.getElementById('statUsers').textContent = data.totalUsers || 0;
      document.getElementById('statLeads').textContent = data.capturedLeads || 0;

      if (data.globalPersona) selectPersona(data.globalPersona);
    } else {
      if (gate) gate.style.display = 'flex';
      if (dash) dash.style.display = 'none';

      // Pre-fill username if available
      const gateUser = document.getElementById('gateUser');
      if (gateUser && !gateUser.value && data.savedUsername) {
        gateUser.value = data.savedUsername;
      }

      const banner = document.getElementById('savedCredsBanner');
      if (banner) {
        banner.style.display = data.hasSavedPassword ? 'block' : 'none';
      }

      // OTP Box handling
      const otpBox = document.getElementById('gateOtpBox');
      if (otpBox) {
        if (data.pendingOtp) {
          otpBox.style.display = 'block';
          document.getElementById('gateOtpPrompt').textContent = '📩 ' + (data.pendingOtp.prompt || 'OTP Verification Code required');
        } else {
          otpBox.style.display = 'none';
        }
      }
    }
  } catch (e) {}
}

async function doGateLogin() {
  const username = document.getElementById('gateUser').value.trim();
  const password = document.getElementById('gatePass').value.trim();
  const saveCheck = document.getElementById('gateSaveCreds');
  const saveCredentials = saveCheck ? saveCheck.checked : true;
  const errBox = document.getElementById('gateError');
  const btn = document.getElementById('gateLoginBtn');

  if (errBox) errBox.style.display = 'none';

  if (!username) {
    if (errBox) {
      errBox.textContent = '❌ Instagram Username daalna zaroori hai!';
      errBox.style.display = 'block';
    }
    return;
  }
  if (!password) {
    if (errBox) {
      errBox.textContent = '❌ Instagram Password daalna zaroori hai!';
      errBox.style.display = 'block';
    }
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Instagram se connect ho raha hai... (Please wait)';

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, saveCredentials })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (errBox) {
        errBox.textContent = '❌ ' + (data.error || 'Instagram login fail ho gaya. Kripya username aur password check karein.');
        errBox.style.display = 'block';
      }
    } else {
      await refreshStatus();
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = '❌ Connection error: ' + err.message;
      errBox.style.display = 'block';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 LOGIN & UNLOCK DASHBOARD';
    refreshStatus();
  }
}

async function submitGateOtp() {
  const code = document.getElementById('gateOtpCode').value.trim();
  if (!code) {
    alert('Please enter the OTP verification code');
    return;
  }
  await fetch('/api/submit-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  document.getElementById('gateOtpCode').value = '';
  refreshStatus();
}

async function disconnectAccount() {
  if (!confirm('Kya aap sure hain ki Instagram account disconnect aur logout karna chahte hain?')) return;
  try {
    await fetch('/api/disconnect', { method: 'POST' });
    const pInp = document.getElementById('gatePass');
    if (pInp) pInp.value = '';
    alert('Instagram account disconnected & logged out successfully!');
  } catch (err) {
    alert('Error: ' + err.message);
  }
  refreshStatus();
}

async function refreshMessages() {
  try {
    const res = await fetch('/api/messages');
    const msgs = await res.json();
    const list = document.getElementById('messagesList');
    if (!list) return;
    if (!msgs || msgs.length === 0) {
      list.innerHTML = '<p style="color: #888; font-size: 13px; text-align: center; padding: 20px;">No messages received yet.</p>';
      return;
    }
    list.innerHTML = msgs.map(m => \`
      <div class="msg-item">
        <div class="msg-header">
          <span style="font-weight: bold; color: #f87171;">@\${m.sender_username || 'user'}</span>
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
    cachedUsers = profiles || [];
    const tbody = document.getElementById('userTableBody');
    if (!tbody) return;
    if (!profiles || profiles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #888; padding: 20px;">No user profiles yet. Once people DM you, they will appear here!</td></tr>';
      return;
    }
    tbody.innerHTML = profiles.map(p => \`
      <tr>
        <td><strong>@\${p.username}</strong> \${p.custom_name ? '(\' + p.custom_name + \')' : ''}</td>
        <td>
          \${p.is_vip ? '<span class="pill yellow" style="font-size:10px;">⭐ VIP</span> ' : ''}
          \${p.is_blocked ? '<span class="pill red" style="font-size:10px;">🚫 Blocked</span>' : '<span class="pill green" style="font-size:10px;">Active</span>'}
        </td>
        <td><span class="pill" style="font-size:10px; border-color:#aaa; color:#ddd;">\${p.persona || 'default'}</span></td>
        <td>
          \${p.lead_phone ? '📱 <a href="tel:' + p.lead_phone + '" style="color:#6ee7b7;">' + p.lead_phone + '</a><br>' : ''}
          \${p.lead_email ? '✉️ <a href="mailto:' + p.lead_email + '" style="color:#60a5fa;">' + p.lead_email + '</a>' : ''}
          \${(!p.lead_phone && !p.lead_email) ? '<span style="color:#666;">No lead</span>' : ''}
        </td>
        <td>
          <button style="padding: 6px 10px; font-size: 11px;" onclick="toggleVip('\${p.username}', \${p.is_vip ? 0 : 1})">\${p.is_vip ? 'Remove VIP' : 'Make VIP'}</button>
          <button style="padding: 6px 10px; font-size: 11px;" onclick="toggleBlock('\${p.username}', \${p.is_blocked ? 0 : 1})">\${p.is_blocked ? 'Unblock' : 'Block'}</button>
          <button style="padding: 6px 10px; font-size: 11px;" onclick="setCustomPersona('\${p.username}')">Set Mood</button>
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

function exportInstaUsersCsv() {
  const users = cachedUsers || [];
  const rows = [
    ['Username', 'Custom Name', 'Persona', 'VIP', 'Blocked', 'Phone', 'Email', 'Notes'],
    ...users.map(u => [
      u.username,
      u.custom_name || '',
      u.persona || 'sweet',
      u.is_vip ? 'Yes' : 'No',
      u.is_blocked ? 'Yes' : 'No',
      u.lead_phone || '',
      u.lead_email || '',
      u.notes || ''
    ])
  ];
  const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\\r\\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'insta-users-leads.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function sendManualDm() {
  const username = document.getElementById('targetUserInput').value.trim();
  const text = document.getElementById('targetMessageInput').value.trim();
  const resDiv = document.getElementById('sendResult');

  if (!username || !text) {
    alert('Please enter username and message');
    return;
  }

  resDiv.style.color = '#fde047';
  resDiv.textContent = 'Sending message to @' + username + '...';

  try {
    const res = await fetch('/api/send-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, text })
    });
    const data = await res.json();
    if (data.success) {
      resDiv.style.color = '#6ee7b7';
      resDiv.textContent = '✅ Message sent successfully!';
      document.getElementById('targetMessageInput').value = '';
      refreshMessages();
    } else {
      resDiv.style.color = '#fca5a5';
      resDiv.textContent = '❌ ' + (data.error || 'Failed to send message');
    }
  } catch(e) {
    resDiv.style.color = '#fca5a5';
    resDiv.textContent = '❌ Error: ' + e.message;
  }
}

// Initial status load and interval timers
refreshStatus();
refreshMessages();
setInterval(refreshStatus, 4000);
setInterval(refreshMessages, 6000);
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

  const isLoggedIn = Boolean(igManager.isLoggedIn && igManager.currentUser);

  res.json({
    status: isLoggedIn ? 'active' : botStats.status,
    isLoggedIn,
    botActive: isBotActive,
    autoReplyEnabled,
    groqAiEnabled,
    savedModelEnabled,
    account: igManager.currentUser ? igManager.currentUser.username : null,
    accountFullName: igManager.currentUser ? (igManager.currentUser.full_name || '') : '',
    accountPk: igManager.currentUser ? String(igManager.currentUser.pk) : '',
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

// STRICT LOGIN GATE: Only save credentials if login actually succeeds!
app.post('/api/connect', async (req, res) => {
  let { username, password, saveCredentials = true } = req.body;
  const credInfo = await creds.getCredentials();

  if (!username) username = credInfo.username;
  if (!password) password = credInfo.password;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: 'Instagram Username aur Password dono daalna zaroori hai!'
    });
  }

  // Set pendingSaveCredentials so startBot will persist ONLY if login succeeds
  if (saveCredentials) {
    pendingSaveCredentials = { username, password };
  } else {
    pendingSaveCredentials = null;
  }

  try {
    const success = await startBot(username, password);
    if (!success) {
      return res.status(401).json({
        success: false,
        error: botStats.error || 'Instagram login fail ho gaya. Kripya apna username aur password check karein.'
      });
    }

    res.json({
      success: true,
      message: 'Instagram login successful!',
      account: igManager.currentUser ? igManager.currentUser.username : username
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Login failed'
    });
  }
});

// Disconnect Instagram Account completely
app.post('/api/disconnect', async (req, res) => {
  try {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    isPolling = false;
    ig = null;
    botUserId = null;
    botStats.status = 'idle';
    botStats.error = null;
    await creds.clearCredentials();
    await igManager.logout();
    res.json({ success: true, message: 'Instagram account disconnected & logged out' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.post('/api/setting/set', async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  await db.setSetting(key, String(value));
  res.json({ success: true, key, value });
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
