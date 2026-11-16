const { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}
}
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const LEGACY_SESSION_FILE = path.join(__dirname, '..', 'session.json');

let pendingOtpResolver = null;
let pendingChallengeInfo = null;

function waitForOtp(promptText) {
  return new Promise((resolve) => {
    pendingChallengeInfo = { prompt: promptText, timestamp: Date.now() };

    let isResolved = false;

    // Terminal prompt fallback
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`👉 ${promptText}: `, (answer) => {
      rl.close();
      if (!isResolved) {
        isResolved = true;
        pendingOtpResolver = null;
        pendingChallengeInfo = null;
        resolve(answer.trim());
      }
    });

    // Web API resolver
    pendingOtpResolver = (code) => {
      if (!isResolved) {
        isResolved = true;
        try { rl.close(); } catch (_) {}
        pendingChallengeInfo = null;
        resolve(code.trim());
      }
    };
  });
}

class InstagramManager {
  constructor() {
    this.currentUser = null;
    this.isLoggedIn = false;
    this.isLoggingIn = false;
    this.setupModernDevice('default_seed');
  }

  setupModernDevice(username) {
    this.ig = new IgApiClient();
    this.ig.state.constants = {
      ...this.ig.state.constants,
      APP_VERSION: '393.1.0.50.76',
      APP_VERSION_CODE: '776586932',
      BLOKS_VERSION_ID: '388ece79ebc0e70e87873505ed1b0ff335ae2868a978cc951b6721c41d46a30a'
    };
    this.ig.state.generateDevice(username);
    this.ig.state.deviceString = '34/14; 480dpi; 1080x2340; samsung; SM-S911B; dm1q; qcom';
  }

  isOtpPending() {
    return pendingChallengeInfo;
  }

  submitOtp(code) {
    if (typeof pendingOtpResolver === 'function') {
      const resolver = pendingOtpResolver;
      pendingOtpResolver = null;
      resolver(code);
      return true;
    }
    return false;
  }

  async saveSession(username) {
    try {
      const serialized = await this.ig.state.serialize();
      delete serialized.constants;

      // 1. Save to Turso DB
      await db.saveSession(username, serialized);

      // 2. Save local backup file
      fs.writeFileSync(SESSION_FILE, JSON.stringify(serialized, null, 2), 'utf8');
      console.log('✅ [Instagram] Session saved to Turso DB & local session.json');
    } catch (err) {
      console.error('⚠️ [Instagram] Failed to save session:', err.message);
    }
  }

  async restoreSession(username) {
    try {
      let sessionData = null;

      // 1. First check Turso DB
      sessionData = await db.getSession(username);
      if (sessionData) {
        console.log('🔄 [Instagram] Restoring session from Turso DB...');
      } else if (fs.existsSync(SESSION_FILE)) {
        console.log('🔄 [Instagram] Restoring session from local session.json...');
        sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      } else if (fs.existsSync(LEGACY_SESSION_FILE)) {
        console.log('🔄 [Instagram] Restoring session from legacy session.json...');
        sessionData = JSON.parse(fs.readFileSync(LEGACY_SESSION_FILE, 'utf8'));
      }

      if (!sessionData) return false;

      await this.ig.state.deserialize(sessionData);

      // Verify session validity
      this.currentUser = await this.ig.account.currentUser();
      this.isLoggedIn = true;
      console.log(`✅ [Instagram] Session restored! Logged in as: @${this.currentUser.username} (${this.currentUser.full_name})`);

      // Sync to Turso DB if it was loaded from file
      await db.saveSession(username, sessionData);
      return true;
    } catch (err) {
      console.warn('⚠️ [Instagram] Session expired or invalid. Fresh login required:', err.message);
      this.isLoggedIn = false;
      this.currentUser = null;
      try {
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      } catch (_) {}
      return false;
    }
  }

  async login(customUsername, customPassword) {
    const username = customUsername || process.env.IG_USERNAME;
    const password = customPassword || process.env.IG_PASSWORD;

    if (!username || !password) {
      throw new Error('IG_USERNAME and IG_PASSWORD must be configured!');
    }

    if (this.isLoggingIn) {
      throw new Error('Login already in progress...');
    }

    this.isLoggingIn = true;
    this.setupModernDevice(username);

    try {
      // Try restoring existing session from Turso DB / local
      const isRestored = await this.restoreSession(username);
      if (isRestored) {
        this.isLoggingIn = false;
        return this.ig;
      }

      console.log(`🔑 [Instagram] Logging in as @${username}...`);

      // Simulate real device pre-login flow
      await this.ig.simulate.preLoginFlow();
      const auth = await this.ig.account.login(username, password);
      this.currentUser = await this.ig.account.currentUser();
      this.isLoggedIn = true;
      console.log(`✅ [Instagram] Login successful! Welcome @${auth.username}`);
      await this.saveSession(username);
      this.isLoggingIn = false;
      return this.ig;
    } catch (err) {
      if (err instanceof IgLoginTwoFactorRequiredError) {
        console.log('🔐 [Instagram] 2FA Required! Two-Factor Authentication is enabled.');
        const twoFactorInfo = err.response.body.two_factor_info;
        const verificationMethod = twoFactorInfo.totp_two_factor_on ? '0' : '1'; // 0 = Authenticator, 1 = SMS

        const promptMsg = `Enter the 6-digit 2FA OTP code sent to your ${verificationMethod === '1' ? 'SMS' : 'Authenticator App'}`;
        const code = await waitForOtp(promptMsg);

        console.log(`🔄 Submitting 2FA code: ${code}...`);
        const auth = await this.ig.account.twoFactorLogin({
          username,
          verificationCode: code,
          twoFactorIdentifier: twoFactorInfo.two_factor_identifier,
          verificationMethod,
        });

        this.currentUser = await this.ig.account.currentUser();
        this.isLoggedIn = true;
        console.log(`✅ [Instagram] 2FA Login successful! Welcome @${auth.username}`);
        await this.saveSession(username);
        this.isLoggingIn = false;
        return this.ig;
      }

      if (err instanceof IgCheckpointError) {
        console.log('🛡️ [Instagram] Checkpoint Challenge detected! Instagram is asking to verify identity.');
        try {
          await this.ig.challenge.auto(true);
          const promptMsg = 'Enter the verification OTP code sent to your registered Phone / Email';
          const code = await waitForOtp(promptMsg);

          console.log(`🔄 Submitting checkpoint code: ${code}...`);
          await this.ig.challenge.sendSecurityCode(code);
          this.currentUser = await this.ig.account.currentUser();
          this.isLoggedIn = true;
          console.log('✅ [Instagram] Checkpoint challenge solved!');
          await this.saveSession(username);
          this.isLoggingIn = false;
          return this.ig;
        } catch (challengeErr) {
          this.isLoggingIn = false;
          console.error('❌ [Instagram] Failed to solve checkpoint challenge:', challengeErr.message);
          throw challengeErr;
        }
      }

      this.isLoggingIn = false;
      console.error('❌ [Instagram] Login error:', err.message);
      throw err;
    }
  }

  async logout() {
    this.isLoggedIn = false;
    this.currentUser = null;
    try {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    } catch (_) {}
  }
}

module.exports = new InstagramManager();
