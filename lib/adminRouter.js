const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const igManager = require('./igClient');
const creds = require('./creds');

const router = express.Router();

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
<title>Admin Login | Insta-Bot</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #09090e;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background-image: radial-gradient(circle at 10% 20%, rgba(131, 58, 180, 0.25) 0%, transparent 40%),
                      radial-gradient(circle at 90% 80%, rgba(253, 29, 29, 0.2) 0%, transparent 40%);
  }
  .login-card {
    background: rgba(18, 18, 26, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 20px;
    padding: 35px 30px;
    width: 100%;
    max-width: 420px;
    backdrop-filter: blur(15px);
    box-shadow: 0 15px 40px rgba(0, 0, 0, 0.6);
    text-align: center;
  }
  h1 {
    font-size: 26px;
    font-weight: 800;
    margin-bottom: 6px;
    background: linear-gradient(135deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .sub { font-size: 13px; color: #94a3b8; margin-bottom: 25px; }
  input {
    width: 100%;
    background: rgba(10, 10, 15, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 14px 16px;
    color: #fff;
    font-size: 15px;
    margin-bottom: 14px;
    outline: none;
    transition: all 0.2s;
  }
  input:focus { border-color: #dc2743; box-shadow: 0 0 12px rgba(220, 39, 67, 0.3); }
  button {
    width: 100%;
    padding: 14px;
    border-radius: 12px;
    border: none;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    background: linear-gradient(135deg, #f09433, #dc2743, #bc1888);
    color: white;
    transition: all 0.2s;
    margin-top: 6px;
  }
  button:hover { opacity: 0.93; transform: translateY(-1px); }
  .error-msg {
    color: #f87171;
    font-size: 13px;
    margin-top: 15px;
    display: none;
  }
</style>
</head>
<body>
<div class="login-card">
  <h1>🛡️ Admin Portal</h1>
  <p class="sub">Insta-Bot Central Management & Turso Data</p>

  <form onsubmit="handleLogin(event)">
    <input type="text" id="username" placeholder="Admin Phone / Username" required autocomplete="username" />
    <input type="password" id="password" placeholder="Admin Password" required autocomplete="current-password" />
    <button type="submit" id="loginBtn">Log In as Admin</button>
  </form>
  <div class="error-msg" id="errMsg">Invalid Admin credentials!</div>
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
    btn.textContent = 'Log In as Admin';
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
<title>🛡️ Master Admin Panel | Insta-Bot</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #08080d;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
    padding: 20px 14px;
    background-image: radial-gradient(circle at 10% 20%, rgba(131, 58, 180, 0.18) 0%, transparent 40%),
                      radial-gradient(circle at 90% 80%, rgba(253, 29, 29, 0.15) 0%, transparent 40%);
  }
  .container { max-width: 1100px; margin: 0 auto; }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 22px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .title-group h1 {
    font-size: 26px;
    font-weight: 800;
    background: linear-gradient(135deg, #f09433, #dc2743, #bc1888);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .title-group p { font-size: 13px; color: #94a3b8; }
  .header-actions { display: flex; align-items: center; gap: 10px; }
  .admin-badge {
    background: rgba(220, 39, 67, 0.15);
    border: 1px solid rgba(220, 39, 67, 0.3);
    color: #f87171;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 700;
  }
  .logout-btn {
    background: rgba(255, 255, 255, 0.08);
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    padding: 7px 14px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .logout-btn:hover { background: rgba(239, 68, 68, 0.2); color: #f87171; border-color: rgba(239, 68, 68, 0.4); }

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

  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  @media(max-width: 700px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
  .stat-card {
    background: rgba(18, 18, 26, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 18px;
    backdrop-filter: blur(12px);
  }
  .stat-val { font-size: 26px; font-weight: 800; color: #fff; margin-bottom: 4px; }
  .stat-lbl { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }

  .card {
    background: rgba(18, 18, 26, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 22px;
    backdrop-filter: blur(12px);
    margin-bottom: 20px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }
  h2 { font-size: 16px; font-weight: 700; color: #f8fafc; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  th { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover { background: rgba(255, 255, 255, 0.02); }

  .badge-source {
    background: rgba(188, 24, 136, 0.15);
    color: #f472b6;
    padding: 3px 8px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-vip {
    background: rgba(234, 179, 8, 0.15);
    color: #facc15;
    padding: 3px 8px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 700;
  }
  .badge-blocked {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
    padding: 3px 8px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 700;
  }
  .action-btn {
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
    color: #e2e8f0;
    margin-right: 4px;
    transition: all 0.2s;
  }
  .action-btn:hover { background: rgba(255, 255, 255, 0.15); }
  .action-danger:hover { background: rgba(239, 68, 68, 0.25); color: #f87171; border-color: rgba(239, 68, 68, 0.4); }
  .action-vip:hover { background: rgba(234, 179, 8, 0.25); color: #facc15; border-color: rgba(234, 179, 8, 0.4); }

  .search-input {
    width: 100%;
    background: rgba(10, 10, 15, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    padding: 10px 14px;
    color: #fff;
    font-size: 13px;
    margin-bottom: 12px;
    outline: none;
  }
  .search-input:focus { border-color: #e6683c; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="title-group">
      <h1>🛡️ Master Admin Panel</h1>
      <p>Insta-Bot Central Management & All Turso Data</p>
    </div>
    <div class="header-actions">
      <span class="admin-badge">Admin: 8115743185</span>
      <button class="logout-btn" onclick="logout()">Log Out</button>
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
      <div class="stat-val" id="statAccount" style="font-size: 20px;">Checking...</div>
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
            <tr><td colspan="5" style="text-align: center; color: #64748b; padding: 20px;">Loading message logs...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 2: CAPTURED LEADS -->
  <div id="atab-leads" class="tab-content">
    <div class="card">
      <h2>🎯 Captured Leads & Customer Contacts</h2>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 12px;">Users who sent their phone numbers or email addresses in Instagram DMs:</p>
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
            <tr><td colspan="4" style="text-align: center; color: #64748b; padding: 20px;">Loading leads...</td></tr>
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
            <tr><td colspan="5" style="text-align: center; color: #64748b; padding: 20px;">Loading users...</td></tr>
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
        <p><strong>Connected Instagram:</strong> <span id="sysAccount">None</span></p>
        <p><strong>Bot Status:</strong> <span id="sysStatus">Active</span></p>
      </div>
      <div style="margin-top: 18px; display: flex; gap: 10px;">
        <button class="action-btn" style="padding: 10px 18px;" onclick="toggleBotAdmin()">Toggle Bot Pause/Resume</button>
      </div>

      <hr style="border: 0; border-top: 1px solid #334155; margin: 24px 0;" />
      <h3>🔐 Instagram Bot Credentials</h3>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 12px;">Admin yahan se Instagram username aur password save ya update kar sakta hai. Yahan save karne ke baad credentials memory, .env aur database me save rahenge:</p>

      <div id="adminCredNotice" style="display: none; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 13px; color: #6ee7b7;">
        🔒 <strong>Credentials Saved:</strong> <span id="adminSavedUser"></span> (Password securely stored)
      </div>

      <div style="max-width: 440px; display: flex; flex-direction: column; gap: 10px;">
        <input type="text" id="adminIgUser" placeholder="Instagram Username" style="padding: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 14px;" />
        <input type="password" id="adminIgPass" placeholder="Instagram Password" style="padding: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 14px;" />
        <div style="display: flex; gap: 10px; margin-top: 4px;">
          <button class="action-btn" onclick="adminSaveIgCreds()" style="flex: 1; padding: 10px 16px; background: #0284c7;">💾 Save & Connect Account</button>
          <button class="action-btn" id="adminClearBtn" onclick="adminClearIgCreds()" style="display: none; background: #dc2626; border-color: #b91c1c; padding: 10px 14px;">Clear Credentials</button>
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
  document.getElementById('atab-' + tab).classList.add('active');
  event.target.classList.add('active');
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

    // Credentials status & prefill
    if (data.savedUsername) {
      const uInp = document.getElementById('adminIgUser');
      if (uInp && !uInp.value) uInp.value = data.savedUsername;
    }
    const notice = document.getElementById('adminCredNotice');
    const clrBtn = document.getElementById('adminClearBtn');
    const pInp = document.getElementById('adminIgPass');
    if (data.hasSavedPassword) {
      if (notice) {
        notice.style.display = 'block';
        document.getElementById('adminSavedUser').textContent = '@' + (data.savedUsername || 'account');
      }
      if (clrBtn) clrBtn.style.display = 'inline-block';
      if (pInp && !pInp.value) pInp.placeholder = '•••••••• (Password Saved - enter new to change)';
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
      leadsTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #64748b; padding: 20px;">No phone/email leads captured yet.</td></tr>';
    } else {
      leadsTbody.innerHTML = leads.map(l => \`
        <tr>
          <td><strong>@\${l.username}</strong></td>
          <td>\${l.lead_phone ? '📱 <a href="tel:' + l.lead_phone + '" style="color:#4ade80;">' + l.lead_phone + '</a>' : '<span style="color:#64748b;">N/A</span>'}</td>
          <td>\${l.lead_email ? '✉️ <a href="mailto:' + l.lead_email + '" style="color:#60a5fa;">' + l.lead_email + '</a>' : '<span style="color:#64748b;">N/A</span>'}</td>
          <td style="color:#94a3b8; font-size:12px;">\${l.updated_at || ''}</td>
        </tr>
      \`).join('');
    }

    // Users
    const usersTbody = document.getElementById('usersTbody');
    const users = data.users || [];
    if (users.length === 0) {
      usersTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 20px;">No user interactions yet.</td></tr>';
    } else {
      usersTbody.innerHTML = users.map(u => \`
        <tr>
          <td><strong>@\${u.username}</strong></td>
          <td>
            \${u.is_vip ? '<span class="badge-vip">⭐ VIP</span> ' : ''}
            \${u.is_blocked ? '<span class="badge-blocked">🚫 Blocked</span>' : '<span style="color:#4ade80;">Active</span>'}
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
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 20px;">No messages found.</td></tr>';
    return;
  }
  tbody.innerHTML = msgs.map(m => \`
    <tr>
      <td style="color: #94a3b8; font-size: 12px; white-space: nowrap;">\${m.created_at || ''}</td>
      <td><strong>@\${m.sender_username || 'user'}</strong></td>
      <td style="color: #f1f5f9;">\${m.incoming_text || ''}</td>
      <td style="color: #4ade80;">\${m.reply_text || ''}</td>
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

async function toggleBotAdmin() {
  await fetch('/api/toggle', { method: 'POST' });
  loadAllData();
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

    res.json({
      stats,
      account: igManager.currentUser ? igManager.currentUser.username : (credInfo.username || null),
      savedUsername: credInfo.username,
      hasSavedPassword: credInfo.hasSavedPassword,
      botStatus: igManager.isLoggedIn ? 'Active' : 'Idle',
      messages,
      users,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  res.json({ success: true, message: 'Instagram credentials saved' });
});

router.post('/admin/api/credentials/clear', requireAdmin, async (req, res) => {
  await creds.clearCredentials();
  res.json({ success: true, message: 'Instagram credentials cleared' });
});

module.exports = router;
