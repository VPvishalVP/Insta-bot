const fs = require('fs');
const path = require('path');
const db = require('./db');
const igManager = require('./igClient');

const ENV_PATH = path.join(__dirname, '..', '.env');

function updateEnvFile(username, password) {
  try {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';

    if (/^IG_USERNAME=.*$/m.test(content)) {
      content = content.replace(/^IG_USERNAME=.*$/m, `IG_USERNAME=${username}`);
    } else {
      content += `\nIG_USERNAME=${username}`;
    }

    if (/^IG_PASSWORD=.*$/m.test(content)) {
      content = content.replace(/^IG_PASSWORD=.*$/m, `IG_PASSWORD=${password}`);
    } else {
      content += `\nIG_PASSWORD=${password}`;
    }

    fs.writeFileSync(ENV_PATH, content, 'utf8');
    process.env.IG_USERNAME = username;
    process.env.IG_PASSWORD = password;
    return true;
  } catch (err) {
    console.error('⚠️ [Creds] Failed to write .env file:', err.message);
    return false;
  }
}

async function saveCredentials(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '').trim();

  // 1. Save to .env
  updateEnvFile(u, p);

  // 2. Save to Turso Cloud DB
  try {
    await db.setSetting('ig_username', u);
    await db.setSetting('ig_password', p);
    console.log(`✅ [Creds] Instagram credentials saved permanently for @${u}`);
  } catch (err) {
    console.error('⚠️ [Creds] Failed to save credentials to DB:', err.message);
  }
  return true;
}

async function getCredentials() {
  let username = process.env.IG_USERNAME || '';
  let password = process.env.IG_PASSWORD || '';

  if (!username || !password) {
    try {
      const dbUser = await db.getSetting('ig_username');
      const dbPass = await db.getSetting('ig_password');
      if (dbUser && !username) username = dbUser;
      if (dbPass && !password) password = dbPass;
      if (username) process.env.IG_USERNAME = username;
      if (password) process.env.IG_PASSWORD = password;
    } catch (_) {}
  }

  return {
    username: username || '',
    password: password || '',
    hasSavedPassword: Boolean(password && password.length > 0)
  };
}

async function clearCredentials() {
  updateEnvFile('', '');
  process.env.IG_USERNAME = '';
  process.env.IG_PASSWORD = '';
  try {
    await db.setSetting('ig_username', '');
    await db.setSetting('ig_password', '');
  } catch (_) {}
  try {
    await igManager.logout();
  } catch (_) {}
  console.log('🗑️ [Creds] Saved Instagram credentials removed completely.');
  return true;
}

module.exports = {
  saveCredentials,
  getCredentials,
  clearCredentials
};
