const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const igManager = require('./igClient');
const creds = require('./creds');

const router = express.Router();

let startBotCallback = null;
function setStartBotHandler(fn) {
  startBotCallback = fn;
}
router.setStartBotHandler = setStartBotHandler;

function getAdminSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );

  const token = cookies['insta_admin_session'];
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const issued = Number(parts[0]);
  const hmac = parts[1];

  // Token expires after 12 hours
  if (!Number.isFinite(issued) || Date.now() - issued > 12 * 60 * 60 * 1000) {
    return false;
  }

  const secret = process.env.ADMIN_PASSWORD || 'admin_secret';
  const expectedHmac = crypto.createHmac('sha256', secret).update(String(issued)).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac));
  } catch (_) {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!getAdminSession(req)) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

// -------------------------------------------------------------
// Admin Pages (Login & Dashboard)
// -------------------------------------------------------------

router.get('/admin', (req, res) => {
  const isAuth = getAdminSession(req);

  if (!isAuth) {
    // Render Admin Login Page
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AAIRA Admin | Instagram Bot</title>
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
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: linear-gradient(145deg, rgba(8,8,8,.78), rgba(22,22,22,.70));
    border: 1px solid #555555;
    border-radius: 18px;
    padding: 30px 26px;
    width: 100%;
    max-width: 440px;
    backdrop-filter: blur(15px);
    box-shadow: 0 10px 32px #000c, 0 0 16px rgba(255, 255, 255, 0.05);
    text-align: center;
  }
  .logo {
    font-size: 28px;
    font-weight: 900;
    letter-spacing: 4px;
    text-shadow: 0 0 16px #ddd;
    background: linear-gradient(110deg, #ffffff 0%, #d8d8d8 38%, #8e8e8e 68%, #ffffff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  h1 {
    font-size: 22px;
    font-weight: 900;
    letter-spacing: 2px;
    margin: 8px 0;
    text-transform: uppercase;
    background: linear-gradient(110deg, #ffffff 0%, #d8d8d8 38%, #8e8e8e 68%, #ffffff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-shadow: 0 0 14px rgba(255, 255, 255, 0.2);
  }
  .sub { font-size: 12px; color: #aaa; margin-bottom: 22px; }
  input {
    width: 100%;
    background: rgba(5,5,5,.75);
    border: 1px solid #666;
    border-radius: 10px;
    padding: 13px 15px;
    color: #fff;
    font-size: 14px;
    margin-bottom: 12px;
    outline: none;
    font-family: inherit;
    transition: border-color .2s;
  }
  input:focus { border-color: #eee; box-shadow: 0 0 8px #777; }
  button {
    width: 100%;
    padding: 13px;
    border-radius: 10px;
    border: 1px solid #aaa;
    font-size: 14px;
    font-weight: bold;
    cursor: pointer;
    background: linear-gradient(135deg, #3d3d3d, #080808);
    color: white;
    font-family: inherit;
    transition: transform .15s, border-color .15s;
    margin-top: 6px;
  }
  button:hover {
    transform: translateY(-1px);
    border-color: #fff;
    background: linear-gradient(135deg, #777, #202020);
    box-shadow: 0 0 14px #aaa;
  }
  .error-msg {
    color: #fca5a5;
    background: rgba(220,38,38,0.2);
    border: 1px solid #ef4444;
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    margin-top: 14px;
    display: none;
  }
</style>
</head>
<body>
<div class="card">
  <div class="logo">VIHUHUHU KA</div>
  <h1>✦ AAIRA ADMIN (INSTAGRAM) ✦</h1>
  <p class="sub">Owner Admin Portal • Central Management & Turso Data</p>

  <form onsubmit="handleLogin(event)">
    <input type="text" id="username" placeholder="Owner Phone / Username" required autocomplete="username" />
    <input type="password" id="password" placeholder="Admin Password" required autocomplete="current-password" />
    <button type="submit" id="loginBtn">LOG IN AS ADMIN</button>
  </form>
  <div class="error-msg" id="errMsg">Invalid Admin credentials!</div>
  <div style="margin-top: 18px;">
    <a href="/" style="color: #888; font-size: 12px; text-decoration: none;">← Back to Instagram Bot Dashboard</a>
  </div>
</div>

<script>
async function handleLogin(e) {
  e.preventDefault();
  const user = document.getElementById('username').value.trim();
  const pass = document.getElementById('password').value.trim();
  const err = document.getElementById('errMsg');
  const btn = document.getElementById('loginBtn');

  btn.disabled = true;
  btn.textContent = 'Verifying...';
  err.style.display = 'none';

  try {
    const res = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass })
    });
    const data = await res.json();
    if (data.success) {
      window.location.reload();
    } else {
      err.textContent = data.error || 'Authentication failed';
      err.style.display = 'block';
    }
  } catch (ex) {
    err.textContent = 'Network error: ' + ex.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'LOG IN AS ADMIN';
  }
}
</script>
</body>
</html>`);
  }

  // Render Full Admin Dashboard
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>✦ AAIRA ADMIN (INSTAGRAM) ✦</title>
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
    padding: 20px 14px;
  }
  .container { max-width: 1050px; margin: 0 auto; }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0 20px;
    border-bottom: 1px solid #444;
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .logo {
    font-size: 26px;
    font-weight: 900;
    letter-spacing: 4px;
    text-shadow: 0 0 16px #ddd;
    background: linear-gradient(110deg, #ffffff 0%, #d8d8d8 38%, #8e8e8e 68%, #ffffff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  h1 {
    font-size: 24px;
    font-weight: 900;
    letter-spacing: 2px;
    margin: 4px 0 0;
    text-transform: uppercase;
    background: linear-gradient(110deg, #ffffff 0%, #d8d8d8 38%, #8e8e8e 68%, #ffffff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-shadow: 0 0 14px rgba(255, 255, 255, 0.25);
  }
  .header-actions { display: flex; align-items: center; gap: 10px; }
  .admin-badge {
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid #10b981;
    color: #6ee7b7;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: bold;
  }
  .logout-btn {
    background: rgba(40, 10, 10, 0.6);
    color: #fca5a5;
    border: 1px solid #7f1d1d;
    padding: 7px 14px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: bold;
    cursor: pointer;
  }
  .logout-btn:hover { background: #dc2626; color: #fff; }

  /* Navigation Tabs */
  .nav-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
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
  .tab-btn:hover { color: #fff; border-color: #777; }
  .tab-btn.active {
    background: linear-gradient(135deg, #444, #111);
    color: #fff;
    border: 1px solid #aaa;
    box-shadow: 0 0 12px rgba(255,255,255,0.15);
  }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  @media(max-width: 700px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
  .stat-card {
    background: linear-gradient(145deg, rgba(8,8,8,.75), rgba(22,22,22,.68));
    border: 1px solid #555;
    border-radius: 14px;
    padding: 16px;
    text-align: center;
    backdrop-filter: blur(12px);
  }
  .stat-val { font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 4px; }
  .stat-lbl { font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 0.5px; }

  .card {
    background: linear-gradient(145deg, rgba(8,8,8,.75), rgba(22,22,22,.68));
    border: 1px solid #555;
    border-radius: 18px;
    padding: 22px;
    backdrop-filter: blur(12px);
    margin-bottom: 20px;
    box-shadow: 0 8px 28px #0009;
  }
  h2 {
    font-size: 16px;
    font-weight: 900;
    color: #fff;
    margin: 0 0 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid #333; }
  th { color: #bbb; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover { background: rgba(255, 255, 255, 0.03); }

  .badge-source {
    background: rgba(188, 24, 136, 0.15);
    color: #f472b6;
    padding: 3px 8px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: bold;
  }
  .badge-vip {
    background: rgba(234, 179, 8, 0.15);
    color: #facc15;
    padding: 3px 8px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: bold;
  }
  .badge-blocked {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
    padding: 3px 8px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: bold;
  }
  .action-btn {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: bold;
    border-radius: 8px;
    cursor: pointer;
    border: 1px solid #aaa;
    background: linear-gradient(135deg, #3d3d3d, #080808);
    color: #fff;
    margin-right: 4px;
    transition: all 0.2s;
  }
  .action-btn:hover { background: #555; }
  .action-danger:hover { background: #dc2626; border-color: #ef4444; }
  .action-vip:hover { background: #d97706; border-color: #f59e0b; }

  .search-input {
    width: 100%;
    background: rgba(5, 5, 5, 0.75);
    border: 1px solid #666;
    border-radius: 10px;
    padding: 11px 14px;
    color: #fff;
    font-size: 13px;
    margin-bottom: 12px;
    outline: none;
    font-family: inherit;
  }
  .search-input:focus { border-color: #eee; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <div class="logo">VIHUHUHU KA</div>
      <h1>✦ AAIRA ADMIN (INSTAGRAM) ✦</h1>
      <p style="font-size: 12px; color: #aaa; margin: 4px 0 0;">VIHUHUHU KA INSTAGRAM BOT MANAGEMENT & CLOUD DATABASE</p>
    </div>
    <div class="header-actions">
      <span class="admin-badge">Admin: 8115743185</span>
      <a href="/" style="color: #aaa; font-size: 12px; text-decoration: none; padding: 7px 12px; border: 1px solid #555; border-radius: 10px;">← Main Bot</a>
      <button class="logout-btn" onclick="logout()">LOG OUT</button>
    </div>
  </header>

  <!-- KPI Stats -->
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-val" id="statReplies">0</div>
      <div class="stat-lbl">Total DM Replies</div>
    </div>
    <div class="stat-card">
      <div class="stat-val" id="statUsers">0</div>
      <div class="stat-lbl">Registered Users</div>
    </div>
    <div class="stat-card">
      <div class="stat-val" id="statLeads">0</div>
      <div class="stat-lbl">Captured Leads</div>
    </div>
    <div class="stat-card">
      <div class="stat-val" id="statAccount" style="font-size: 18px; color: #6ee7b7;">Checking...</div>
      <div class="stat-lbl">Active Account</div>
    </div>
  </div>

  <!-- Navigation Tabs -->
  <div class="nav-tabs">
    <button class="tab-btn active" onclick="switchAdminTab('messages')">💬 All Messages & Replies</button>
    <button class="tab-btn" onclick="switchAdminTab('leads')">🎯 Captured Leads (Phone/Email)</button>
    <button class="tab-btn" onclick="switchAdminTab('users')">👥 User Management & VIP</button>
    <button class="tab-btn" onclick="switchAdminTab('system')">⚙️ Account & Bot Control</button>
  </div>

  <!-- TAB 1: ALL MESSAGES -->
  <div id="atab-messages" class="tab-content active">
    <div class="card">
      <h2>💬 Complete Message History (Turso DB)</h2>
      <input type="text" id="msgSearch" class="search-input" placeholder="Search by username or text..." oninput="filterMessages()" />
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Username</th>
              <th>Incoming Message</th>
              <th>Bot Reply</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody id="messagesTbody">
            <tr><td colspan="5" style="text-align: center; color: #888; padding: 20px;">Loading message logs...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 2: CAPTURED LEADS -->
  <div id="atab-leads" class="tab-content">
    <div class="card">
      <h2>🎯 Captured Leads & Customer Contacts</h2>
      <p style="font-size: 12px; color: #aaa; margin-bottom: 12px;">Users who sent their phone numbers or email addresses in Instagram DMs:</p>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Phone Number</th>
              <th>Email</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody id="leadsTbody">
            <tr><td colspan="4" style="text-align: center; color: #888; padding: 20px;">Loading leads...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 3: USERS & VIP -->
  <div id="atab-users" class="tab-content">
    <div class="card">
      <h2>👥 User Management & Access Controls</h2>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Status</th>
              <th>Custom Persona</th>
              <th>Total Msgs</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="usersTbody">
            <tr><td colspan="5" style="text-align: center; color: #888; padding: 20px;">Loading users...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 4: SYSTEM & ACCOUNT -->
  <div id="atab-system" class="tab-content">
    <div class="card">
      <h2>⚙️ Bot Control & Account Info</h2>
      <div style="font-size: 14px; line-height: 1.8; color: #cbd5e1;">
        <p><strong>Database:</strong> Cloud Turso DB (AWS ap-south-1)</p>
        <p><strong>Connected Instagram:</strong> <span id="sysAccount" style="color: #6ee7b7; font-weight: bold;">None</span></p>
        <p><strong>Bot Status:</strong> <span id="sysStatus">Active</span></p>
      </div>

      <div style="margin-top: 18px; display: flex; gap: 8px; flex-wrap: wrap;">
        <button id="adminBotBtn" class="action-btn" onclick="toggleSettingAdmin('bot_active')">BOT ON</button>
        <button id="adminAutoReplyBtn" class="action-btn" onclick="toggleSettingAdmin('auto_reply_enabled')">AUTO REPLY ON</button>
        <button id="adminGroqBtn" class="action-btn" onclick="toggleSettingAdmin('groq_ai_enabled')">GROQ AI ON</button>
        <button id="adminSavedModelBtn" class="action-btn" onclick="toggleSettingAdmin('saved_model_enabled')">SAVED RULES ON</button>
        <button class="action-btn" style="background: linear-gradient(135deg, #059669, #047857); border-color: #10b981;" onclick="exportInstaUsers()">Export CSV</button>
      </div>

      <hr style="border: 0; border-top: 1px solid #444; margin: 24px 0;" />
      <h3 style="font-size: 15px; margin-bottom: 8px;">🔐 Instagram Bot Credentials</h3>
      <p style="font-size: 12px; color: #aaa; margin-bottom: 12px;">Admin yahan se saved Instagram username aur password dekh sakta hai, edit/save kar sakta hai, aur direct connect kar sakta hai:</p>

      <div id="adminCredNotice" style="display: none; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; padding: 12px 16px; border-radius: 10px; margin-bottom: 14px; font-size: 13px; color: #6ee7b7;">
        <div>🔒 <strong>Saved Instagram Account:</strong> <span id="adminSavedUser" style="font-weight: 700; color: #fff;"></span></div>
        <div style="margin-top: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span><strong>Saved Password:</strong></span>
          <code id="adminSavedPassDisplay" style="background: #000; padding: 3px 8px; border-radius: 4px; color: #38bdf8; font-size: 13px;">••••••••</code>
          <button type="button" onclick="toggleAdminPassVisibility()" style="background: #333; border: 1px solid #555; color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;">👁️ Show / Hide</button>
          <button type="button" onclick="copySavedPass()" style="background: #0284c7; border: 0; color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;">📋 Copy</button>
        </div>
      </div>

      <div style="max-width: 460px; display: flex; flex-direction: column; gap: 10px;">
        <label style="font-size: 12px; color: #bbb; margin-bottom: -4px;">Instagram Username</label>
        <input type="text" id="adminIgUser" placeholder="Instagram Username" style="padding: 10px; border-radius: 8px; border: 1px solid #666; background: rgba(5,5,5,0.75); color: #fff; font-size: 14px;" />

        <label style="font-size: 12px; color: #bbb; margin-bottom: -4px;">Instagram Password</label>
        <div style="display: flex; gap: 6px;">
          <input type="password" id="adminIgPass" placeholder="Instagram Password" style="flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #666; background: rgba(5,5,5,0.75); color: #fff; font-size: 14px;" />
          <button type="button" onclick="toggleInputType('adminIgPass')" style="background: #333; border: 1px solid #555; color: #fff; border-radius: 8px; padding: 0 12px; cursor: pointer;">👁️</button>
        </div>

        <div style="display: flex; gap: 10px; margin-top: 4px;">
          <button class="action-btn" onclick="adminSaveIgCreds()" style="flex: 1; padding: 12px 16px; background: linear-gradient(135deg, #0284c7, #0369a1); border-color: #38bdf8;">💾 Save & Connect Account</button>
          <button class="action-btn" id="adminClearBtn" onclick="adminClearIgCreds()" style="display: none; background: #dc2626; border-color: #b91c1c; padding: 12px 14px;">Clear Credentials</button>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
let allMessages = [];

function switchAdminTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('atab-' + tab);
  if (target) target.classList.add('active');
  if (event && event.target && event.target.classList.contains('tab-btn')) {
    event.target.classList.add('active');
  }
}

async function loadAllData() {
  try {
    const res = await fetch('/admin/api/all-data');
    if (res.status === 401) {
      window.location.reload();
      return;
    }
    const data = await res.json();

    // Stats
    document.getElementById('statReplies').textContent = data.stats.totalReplies || 0;
    document.getElementById('statUsers').textContent = data.stats.totalUsers || 0;
    document.getElementById('statLeads').textContent = data.stats.capturedLeads || 0;
    document.getElementById('statAccount').textContent = data.account ? '@' + data.account : 'Not Connected';
    document.getElementById('sysAccount').textContent = data.account ? '@' + data.account : 'Not Connected';
    document.getElementById('sysStatus').textContent = data.botStatus || 'Active';

    // Control Buttons (same as wa-bot)
    function updateToggleBtn(id, label, active) {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.textContent = label + ' ' + (active ? 'ON' : 'OFF');
      btn.style.background = active ? 'linear-gradient(135deg,#059669,#047857)' : 'linear-gradient(135deg,#dc2626,#991b1b)';
      btn.style.borderColor = active ? '#10b981' : '#ef4444';
    }
    updateToggleBtn('adminBotBtn', 'BOT', data.botActive !== false);
    updateToggleBtn('adminAutoReplyBtn', 'AUTO REPLY', data.autoReplyEnabled !== false);
    updateToggleBtn('adminGroqBtn', 'GROQ AI', data.groqAiEnabled !== false);
    updateToggleBtn('adminSavedModelBtn', 'SAVED RULES', data.savedModelEnabled !== false);

    // Credentials status & prefill
    window.realSavedPassword = data.savedPassword || '';
    if (data.savedUsername) {
      const uInp = document.getElementById('adminIgUser');
      if (uInp && !uInp.value) uInp.value = data.savedUsername;
    }
    const notice = document.getElementById('adminCredNotice');
    const clrBtn = document.getElementById('adminClearBtn');
    const pInp = document.getElementById('adminIgPass');
    const passDisplay = document.getElementById('adminSavedPassDisplay');

    if (data.hasSavedPassword) {
      if (notice) {
        notice.style.display = 'block';
        document.getElementById('adminSavedUser').textContent = '@' + (data.savedUsername || 'account');
        if (passDisplay) {
          passDisplay.textContent = window.isPassVisible ? window.realSavedPassword : '••••••••';
        }
      }
      if (clrBtn) clrBtn.style.display = 'inline-block';
      if (pInp && !pInp.value) {
        pInp.value = window.realSavedPassword;
      }
    } else {
      if (notice) notice.style.display = 'none';
      if (clrBtn) clrBtn.style.display = 'none';
      if (pInp && !pInp.value) pInp.placeholder = 'Instagram Password';
    }

    // Messages
    allMessages = data.messages || [];
    renderMessages(allMessages);

    // Leads
    const leadsTbody = document.getElementById('leadsTbody');
    const leads = (data.users || []).filter(u => u.lead_phone || u.lead_email);
    if (leads.length === 0) {
      leadsTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #888; padding: 20px;">No phone/email leads captured yet.</td></tr>';
    } else {
      leadsTbody.innerHTML = leads.map(l => \`
        <tr>
          <td><strong>@\${l.username}</strong></td>
          <td>\${l.lead_phone ? '📱 <a href="tel:' + l.lead_phone + '" style="color:#6ee7b7;">' + l.lead_phone + '</a>' : '<span style="color:#666;">N/A</span>'}</td>
          <td>\${l.lead_email ? '✉️ <a href="mailto:' + l.lead_email + '" style="color:#60a5fa;">' + l.lead_email + '</a>' : '<span style="color:#666;">N/A</span>'}</td>
          <td style="color:#888; font-size:12px;">\${l.updated_at || ''}</td>
        </tr>
      \`).join('');
    }

    // Users
    const usersTbody = document.getElementById('usersTbody');
    const users = data.users || [];
    window.cachedUsersList = users;
    if (users.length === 0) {
      usersTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #888; padding: 20px;">No user interactions yet.</td></tr>';
    } else {
      usersTbody.innerHTML = users.map(u => \`
        <tr>
          <td><strong>@\${u.username}</strong></td>
          <td>
            \${u.is_vip ? '<span class="badge-vip">⭐ VIP</span> ' : ''}
            \${u.is_blocked ? '<span class="badge-blocked">🚫 Blocked</span>' : '<span style="color:#6ee7b7;">Active</span>'}
          </td>
          <td><span class="badge-source">\${u.persona || 'default'}</span></td>
          <td>\${u.message_count || 1}</td>
          <td>
            <button class="action-btn action-vip" onclick="adminToggleVip('\${u.username}', \${u.is_vip ? 0 : 1})">\${u.is_vip ? 'Remove VIP' : 'Make VIP'}</button>
            <button class="action-btn action-danger" onclick="adminToggleBlock('\${u.username}', \${u.is_blocked ? 0 : 1})">\${u.is_blocked ? 'Unblock' : 'Block'}</button>
          </td>
        </tr>
      \`).join('');
    }
  } catch (err) {}
}

function renderMessages(msgs) {
  const tbody = document.getElementById('messagesTbody');
  if (!msgs || msgs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #888; padding: 20px;">No messages found.</td></tr>';
    return;
  }
  tbody.innerHTML = msgs.map(m => \`
    <tr>
      <td style="color: #888; font-size: 12px; white-space: nowrap;">\${m.created_at || ''}</td>
      <td><strong>@\${m.sender_username || 'user'}</strong></td>
      <td style="color: #f1f5f9;">\${m.incoming_text || ''}</td>
      <td style="color: #6ee7b7;">\${m.reply_text || ''}</td>
      <td><span class="badge-source">\${m.source || 'ai'}</span></td>
    </tr>
  \`).join('');
}

function filterMessages() {
  const query = document.getElementById('msgSearch').value.toLowerCase().trim();
  if (!query) {
    renderMessages(allMessages);
    return;
  }
  const filtered = allMessages.filter(m => 
    (m.sender_username && m.sender_username.toLowerCase().includes(query)) ||
    (m.incoming_text && m.incoming_text.toLowerCase().includes(query)) ||
    (m.reply_text && m.reply_text.toLowerCase().includes(query))
  );
  renderMessages(filtered);
}

async function adminToggleVip(username, is_vip) {
  await fetch('/api/profiles/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, is_vip })
  });
  loadAllData();
}

async function adminToggleBlock(username, is_blocked) {
  await fetch('/api/profiles/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, is_blocked })
  });
  loadAllData();
}

window.isPassVisible = false;
window.realSavedPassword = '';

function toggleAdminPassVisibility() {
  const display = document.getElementById('adminSavedPassDisplay');
  if (!display) return;
  window.isPassVisible = !window.isPassVisible;
  if (window.isPassVisible) {
    display.textContent = window.realSavedPassword || '(No password saved)';
  } else {
    display.textContent = window.realSavedPassword ? '••••••••' : '(No password saved)';
  }
}

function copySavedPass() {
  if (!window.realSavedPassword) {
    alert('Koi saved password nahi hai copy karne ke liye.');
    return;
  }
  navigator.clipboard.writeText(window.realSavedPassword).then(() => {
    alert('Instagram Password clipboard me copy ho gaya: ' + window.realSavedPassword);
  }).catch(() => {
    prompt('Copy Instagram Password:', window.realSavedPassword);
  });
}

function toggleInputType(id) {
  const inp = document.getElementById(id);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function toggleSettingAdmin(key) {
  try {
    await fetch('/admin/api/setting/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    loadAllData();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function exportInstaUsers() {
  const users = window.cachedUsersList || [];
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

async function adminSaveIgCreds() {
  const username = document.getElementById('adminIgUser').value.trim();
  const password = document.getElementById('adminIgPass').value.trim();
  if (!username) {
    alert('Instagram Username zaroori hai');
    return;
  }
  const res = await fetch('/admin/api/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (res.ok) {
    alert('Instagram credentials successfully saved & bot connecting!');
    loadAllData();
  } else {
    alert('Error: ' + (data.error || 'Failed to save'));
  }
}

async function adminClearIgCreds() {
  if (!confirm('Are you sure you want to clear saved Instagram credentials?')) return;
  await fetch('/admin/api/credentials/clear', { method: 'POST' });
  document.getElementById('adminIgUser').value = '';
  document.getElementById('adminIgPass').value = '';
  window.realSavedPassword = '';
  alert('Saved Instagram credentials cleared!');
  loadAllData();
}

async function logout() {
  await fetch('/admin/api/logout', { method: 'POST' });
  window.location.reload();
}

loadAllData();
setInterval(loadAllData, 5000);
</script>
</body>
</html>`);
});

// -------------------------------------------------------------
// Admin APIs
// -------------------------------------------------------------

router.post('/admin/api/login', (req, res) => {
  const adminUser = String(process.env.ADMIN_USER || '8115743185').trim();
  const adminPass = String(process.env.ADMIN_PASSWORD || 'VPvishal143@').trim();

  const inputUser = String(req.body.user || '').trim();
  const inputPass = String(req.body.pass || '').trim();

  if (inputUser === adminUser && inputPass === adminPass) {
    const issued = String(Date.now());
    const secret = process.env.ADMIN_PASSWORD || 'admin_secret';
    const hmac = crypto.createHmac('sha256', secret).update(issued).digest('hex');
    const token = `${issued}.${hmac}`;

    res.setHeader(
      'Set-Cookie',
      `insta_admin_session=${token}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=43200`
    );
    return res.json({ success: true });
  }

  return res.status(401).json({ error: 'Invalid phone or password' });
});

router.post('/admin/api/logout', (req, res) => {
  res.setHeader(
    'Set-Cookie',
    'insta_admin_session=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0'
  );
  res.json({ success: true });
});

router.get('/admin/api/all-data', requireAdmin, async (req, res) => {
  try {
    const stats = await db.getStats();
    const messages = await db.getRecentMessages(100);
    const users = await db.getAllProfiles();
    const credInfo = await creds.getCredentials();

    const isBotActive = (await db.getSetting('bot_active', 'true')) === 'true';
    const autoReplyEnabled = (await db.getSetting('auto_reply_enabled', 'true')) === 'true';
    const groqAiEnabled = (await db.getSetting('groq_ai_enabled', 'true')) === 'true';
    const savedModelEnabled = (await db.getSetting('saved_model_enabled', 'true')) === 'true';

    res.json({
      stats,
      account: igManager.currentUser ? igManager.currentUser.username : (credInfo.username || null),
      savedUsername: credInfo.username,
      hasSavedPassword: credInfo.hasSavedPassword,
      savedPassword: credInfo.password,
      botStatus: igManager.isLoggedIn ? 'Active' : 'Idle',
      botActive: isBotActive,
      autoReplyEnabled,
      groqAiEnabled,
      savedModelEnabled,
      messages,
      users,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/api/setting/toggle', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  const current = (await db.getSetting(key, 'true')) === 'true';
  const next = !current;
  await db.setSetting(key, String(next));
  res.json({ success: true, key, value: next });
});

router.post('/admin/api/credentials', requireAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  const current = await creds.getCredentials();
  const finalPassword = password || current.password;
  if (!finalPassword) {
    return res.status(400).json({ error: 'Password required' });
  }
  await creds.saveCredentials(username, finalPassword);
  if (typeof startBotCallback === 'function') {
    startBotCallback(username, finalPassword);
  }
  res.json({ success: true, message: 'Instagram credentials saved and bot connecting' });
});

router.post('/admin/api/credentials/clear', requireAdmin, async (req, res) => {
  await creds.clearCredentials();
  res.json({ success: true, message: 'Instagram credentials cleared' });
});

module.exports = router;
