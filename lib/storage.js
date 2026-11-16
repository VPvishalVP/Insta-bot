const fs = require('fs');
const path = require('path');

const STORAGE_FILE = path.join(__dirname, '..', 'processed_messages.json');
const MAX_STORED = 3000;

class Storage {
  constructor() {
    this.processedIds = new Set();
    this.lastReplyTimes = new Map();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
        if (Array.isArray(data)) {
          this.processedIds = new Set(data);
        }
      }
    } catch (err) {
      console.warn('[Storage] Error loading processed messages:', err.message);
      this.processedIds = new Set();
    }
  }

  save() {
    try {
      const arr = Array.from(this.processedIds).slice(-MAX_STORED);
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Storage] Error saving processed messages:', err.message);
    }
  }

  hasBeenProcessed(itemId) {
    return this.processedIds.has(String(itemId));
  }

  markProcessed(itemId) {
    this.processedIds.add(String(itemId));
    if (this.processedIds.size % 10 === 0) {
      this.save();
    }
  }

  canReplyToUser(userId, minIntervalSeconds = 10) {
    const now = Date.now();
    const last = this.lastReplyTimes.get(String(userId)) || 0;
    if (now - last < minIntervalSeconds * 1000) {
      return false;
    }
    this.lastReplyTimes.set(String(userId), now);
    return true;
  }
}

module.exports = new Storage();
