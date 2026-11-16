require('dotenv').config();
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({
  url,
  authToken: authToken || undefined,
});

class DatabaseManager {
  constructor() {
    this.client = client;
    this.memoryCache = new Set();
    this.lastReplyTimes = new Map();
  }

  async init() {
    console.log('🔄 [Turso DB] Initializing tables...');
    try {
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS insta_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT,
          sender_id TEXT,
          sender_username TEXT,
          incoming_text TEXT,
          reply_text TEXT,
          source TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);

      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS insta_sessions (
          username TEXT PRIMARY KEY,
          session_data TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);

      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS insta_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);

      // NEW: Multi-turn conversation memory per user (Sabka context alag rahega)
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS insta_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          role TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);

      // NEW: Per-user Profiles (Persona, VIP, Leads, Notes)
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS insta_user_profiles (
          username TEXT PRIMARY KEY,
          custom_name TEXT,
          persona TEXT DEFAULT 'sweet',
          is_vip INTEGER DEFAULT 0,
          is_blocked INTEGER DEFAULT 0,
          lead_phone TEXT,
          lead_email TEXT,
          notes TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);

      // Preload recent message IDs into in-memory cache for fast lookups
      const res = await this.client.execute(`
        SELECT id FROM insta_messages ORDER BY created_at DESC LIMIT 2000;
      `);
      for (const row of res.rows) {
        if (row.id) {
          this.memoryCache.add(String(row.id));
        }
      }

      console.log(`✅ [Turso DB] Connected & initialized! Cached ${this.memoryCache.size} recent messages.`);
    } catch (err) {
      console.error('❌ [Turso DB] Initialization error:', err.message);
      throw err;
    }
  }

  isMessageProcessed(itemId) {
    return this.memoryCache.has(String(itemId));
  }

  async recordProcessedMessage({ itemId, threadId, senderId, senderUsername, incomingText, replyText, source }) {
    const idStr = String(itemId);
    this.memoryCache.add(idStr);

    try {
      await this.client.execute({
        sql: `INSERT OR REPLACE INTO insta_messages 
              (id, thread_id, sender_id, sender_username, incoming_text, reply_text, source, created_at) 
              VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [
          idStr,
          String(threadId || ''),
          String(senderId || ''),
          String(senderUsername || ''),
          String(incomingText || '').slice(0, 2000),
          String(replyText || '').slice(0, 2000),
          String(source || 'direct')
        ]
      });

      // Save multi-turn conversation memory
      if (senderUsername && incomingText) {
        await this.addConversationTurn(senderUsername, 'user', incomingText);
      }
      if (senderUsername && replyText) {
        await this.addConversationTurn(senderUsername, 'assistant', replyText);
      }

      // Check if user shared phone or email (Lead capture)
      await this.extractAndSaveLeads(senderUsername, incomingText);
    } catch (err) {
      console.warn('⚠️ [Turso DB] Error saving message record:', err.message);
    }
  }

  async addConversationTurn(username, role, message) {
    try {
      await this.client.execute({
        sql: `INSERT INTO insta_conversations (username, role, message, created_at) VALUES (?, ?, ?, datetime('now'))`,
        args: [String(username).toLowerCase(), role, String(message).slice(0, 1000)]
      });
    } catch (_) {}
  }

  async getUserHistory(username, limit = 6) {
    try {
      const res = await this.client.execute({
        sql: `SELECT role, message FROM insta_conversations WHERE username = ? ORDER BY id DESC LIMIT ?`,
        args: [String(username).toLowerCase(), limit]
      });
      // Return in chronological order
      return res.rows.reverse().map(r => ({ role: r.role, content: r.message }));
    } catch (err) {
      return [];
    }
  }

  async getUserProfile(username) {
    const cleanUser = String(username).toLowerCase();
    try {
      const res = await this.client.execute({
        sql: `SELECT * FROM insta_user_profiles WHERE username = ? LIMIT 1`,
        args: [cleanUser]
      });
      if (res.rows.length > 0) {
        return res.rows[0];
      }
    } catch (_) {}
    return {
      username: cleanUser,
      persona: 'default',
      is_vip: 0,
      is_blocked: 0,
      lead_phone: null,
      lead_email: null
    };
  }

  async updateUserProfile(username, data) {
    const cleanUser = String(username).toLowerCase();
    try {
      const existing = await this.getUserProfile(cleanUser);
      const persona = data.persona !== undefined ? data.persona : existing.persona || 'default';
      const is_vip = data.is_vip !== undefined ? data.is_vip : existing.is_vip || 0;
      const is_blocked = data.is_blocked !== undefined ? data.is_blocked : existing.is_blocked || 0;
      const lead_phone = data.lead_phone !== undefined ? data.lead_phone : existing.lead_phone || null;
      const lead_email = data.lead_email !== undefined ? data.lead_email : existing.lead_email || null;
      const custom_name = data.custom_name !== undefined ? data.custom_name : existing.custom_name || null;

      await this.client.execute({
        sql: `INSERT OR REPLACE INTO insta_user_profiles 
              (username, custom_name, persona, is_vip, is_blocked, lead_phone, lead_email, updated_at) 
              VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [cleanUser, custom_name, persona, is_vip, is_blocked, lead_phone, lead_email]
      });
    } catch (err) {
      console.warn('⚠️ [Turso DB] Error updating user profile:', err.message);
    }
  }

  async getAllProfiles() {
    try {
      const res = await this.client.execute(`
        SELECT p.*, COUNT(m.id) as message_count 
        FROM insta_user_profiles p
        LEFT JOIN insta_messages m ON LOWER(m.sender_username) = p.username
        GROUP BY p.username
        ORDER BY p.updated_at DESC LIMIT 50
      `);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  async extractAndSaveLeads(username, text) {
    if (!text || !username) return;
    const cleanText = String(text);

    // Extract 10-digit Indian/international phone numbers
    const phoneMatch = cleanText.match(/(?:\+?91[\-\s]?)?[6-9]\d{9}\b/);
    // Extract emails
    const emailMatch = cleanText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

    if (phoneMatch || emailMatch) {
      try {
        const profile = await this.getUserProfile(username);
        const newPhone = phoneMatch ? phoneMatch[0].replace(/\s+/g, '') : profile.lead_phone;
        const newEmail = emailMatch ? emailMatch[0].toLowerCase() : profile.lead_email;

        await this.updateUserProfile(username, {
          lead_phone: newPhone,
          lead_email: newEmail
        });
        console.log(`🎯 [Lead Captured] @${username} Phone: ${newPhone || 'N/A'}, Email: ${newEmail || 'N/A'}`);
      } catch (_) {}
    }
  }

  async saveSession(username, sessionData) {
    try {
      const dataStr = typeof sessionData === 'string' ? sessionData : JSON.stringify(sessionData);
      await this.client.execute({
        sql: `INSERT OR REPLACE INTO insta_sessions (username, session_data, updated_at) VALUES (?, ?, datetime('now'))`,
        args: [String(username).toLowerCase(), dataStr]
      });
      console.log(`✅ [Turso DB] Session saved to database for @${username}`);
    } catch (err) {
      console.warn('⚠️ [Turso DB] Error saving session to database:', err.message);
    }
  }

  async getSession(username) {
    try {
      const res = await this.client.execute({
        sql: `SELECT session_data FROM insta_sessions WHERE username = ? LIMIT 1`,
        args: [String(username).toLowerCase()]
      });
      if (res.rows.length > 0 && res.rows[0].session_data) {
        return JSON.parse(res.rows[0].session_data);
      }
    } catch (err) {
      console.warn('⚠️ [Turso DB] Error reading session from database:', err.message);
    }
    return null;
  }

  canReplyToUser(userId, minIntervalSeconds = 8) {
    const now = Date.now();
    const last = this.lastReplyTimes.get(String(userId)) || 0;
    if (now - last < minIntervalSeconds * 1000) {
      return false;
    }
    this.lastReplyTimes.set(String(userId), now);
    return true;
  }

  async getSetting(key, defaultValue = null) {
    try {
      const res = await this.client.execute({
        sql: `SELECT value FROM insta_settings WHERE key = ? LIMIT 1`,
        args: [key]
      });
      if (res.rows.length > 0 && res.rows[0].value !== null) {
        return res.rows[0].value;
      }
    } catch (_) {}
    return defaultValue;
  }

  async setSetting(key, value) {
    try {
      await this.client.execute({
        sql: `INSERT OR REPLACE INTO insta_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
        args: [key, String(value)]
      });
    } catch (_) {}
  }

  async getStats() {
    try {
      const res = await this.client.execute(`SELECT COUNT(*) as total FROM insta_messages`);
      const leadRes = await this.client.execute(`
        SELECT COUNT(*) as total FROM insta_user_profiles WHERE lead_phone IS NOT NULL OR lead_email IS NOT NULL
      `);
      const userRes = await this.client.execute(`
        SELECT COUNT(DISTINCT username) as total FROM insta_conversations
      `);
      return {
        totalReplies: Number(res.rows[0]?.total || 0),
        capturedLeads: Number(leadRes.rows[0]?.total || 0),
        totalUsers: Number(userRes.rows[0]?.total || 0),
        cachedIds: this.memoryCache.size
      };
    } catch (_) {
      return { totalReplies: 0, capturedLeads: 0, totalUsers: 0, cachedIds: this.memoryCache.size };
    }
  }

  async getRecentMessages(limit = 20) {
    try {
      const res = await this.client.execute({
        sql: `SELECT id, thread_id, sender_username, incoming_text, reply_text, source, created_at 
              FROM insta_messages ORDER BY created_at DESC LIMIT ?`,
        args: [limit]
      });
      return res.rows;
    } catch (err) {
      console.warn('⚠️ [Turso DB] Error fetching recent messages:', err.message);
      return [];
    }
  }
}

module.exports = new DatabaseManager();
