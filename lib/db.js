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
    } catch (err) {
      console.warn('⚠️ [Turso DB] Error saving message record:', err.message);
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

  async getStats() {
    try {
      const res = await this.client.execute(`SELECT COUNT(*) as total FROM insta_messages`);
      return {
        totalReplies: Number(res.rows[0]?.total || 0),
        cachedIds: this.memoryCache.size
      };
    } catch (_) {
      return { totalReplies: 0, cachedIds: this.memoryCache.size };
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
