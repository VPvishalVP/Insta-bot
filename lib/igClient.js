const { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SESSION_FILE = path.join(__dirname, '..', 'session.json');

function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

class InstagramManager {
  constructor() {
    this.ig = new IgApiClient();
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
      }

      if (!sessionData) return false;

      await this.ig.state.deserialize(sessionData);

      // Verify session validity
      const user = await this.ig.account.currentUser();
      console.log(`✅ [Instagram] Session restored! Logged in as: @${user.username} (${user.full_name})`);

      // Sync to Turso DB if it was loaded from file
      await db.saveSession(username, sessionData);
      return true;
    } catch (err) {
      console.warn('⚠️ [Instagram] Session expired or invalid. Fresh login required:', err.message);
      try {
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      } catch (_) {}
      return false;
    }
  }

  async login() {
    const username = process.env.IG_USERNAME;
    const password = process.env.IG_PASSWORD;

    if (!username || !password) {
      throw new Error('IG_USERNAME and IG_PASSWORD must be set in .env file!');
    }

    this.ig.state.generateDevice(username);

    // Try restoring existing session from Turso DB / local
    const isRestored = await this.restoreSession(username);
    if (isRestored) {
      return this.ig;
    }

    console.log(`🔑 [Instagram] Logging in as @${username}...`);

    try {
      // Simulate real device pre-login flow
      await this.ig.simulate.preLoginFlow();
      const auth = await this.ig.account.login(username, password);
      console.log(`✅ [Instagram] Login successful! Welcome @${auth.username}`);
      await this.saveSession(username);
      return this.ig;
    } catch (err) {
      if (err instanceof IgLoginTwoFactorRequiredError) {
        console.log('🔐 [Instagram] 2FA Required! Two-Factor Authentication is enabled.');
        const twoFactorInfo = err.response.body.two_factor_info;
        const verificationMethod = twoFactorInfo.totp_two_factor_on ? '0' : '1'; // 0 = Authenticator, 1 = SMS

        console.log(`📩 A 2FA verification code was sent (${verificationMethod === '1' ? 'SMS' : 'Authenticator App'}).`);
        const code = await promptUser('👉 Please enter the 6-digit 2FA OTP code: ');

        const auth = await this.ig.account.twoFactorLogin({
          username,
          verificationCode: code,
          twoFactorIdentifier: twoFactorInfo.two_factor_identifier,
          verificationMethod,
        });

        console.log(`✅ [Instagram] 2FA Login successful! Welcome @${auth.username}`);
        await this.saveSession(username);
        return this.ig;
      }

      if (err instanceof IgCheckpointError) {
        console.log('🛡️ [Instagram] Checkpoint Challenge detected! Instagram is asking to verify identity.');
        try {
          await this.ig.challenge.auto(true);
          console.log('📩 A verification OTP code was sent to your registered Phone / Email.');
          const code = await promptUser('👉 Enter the OTP code received: ');
          await this.ig.challenge.sendSecurityCode(code);
          console.log('✅ [Instagram] Checkpoint challenge solved!');
          await this.saveSession(username);
          return this.ig;
        } catch (challengeErr) {
          console.error('❌ [Instagram] Failed to solve checkpoint challenge:', challengeErr.message);
          throw challengeErr;
        }
      }

      console.error('❌ [Instagram] Login error:', err.message);
      throw err;
    }
  }
}

module.exports = new InstagramManager();
