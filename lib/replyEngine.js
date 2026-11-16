const fs = require('fs');
const path = require('path');
const aiService = require('./aiService');

const RULES_FILE = path.join(__dirname, '..', 'rules.json');

class ReplyEngine {
  constructor() {
    this.rules = [];
    this.loadRules();
  }

  loadRules() {
    try {
      if (fs.existsSync(RULES_FILE)) {
        this.rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
      }
    } catch (err) {
      console.warn('⚠️ [ReplyEngine] Could not load rules.json:', err.message);
      this.rules = [];
    }
  }

  findRuleMatch(messageText) {
    if (!messageText) return null;
    const lower = messageText.toLowerCase().trim();

    for (const rule of this.rules) {
      if (Array.isArray(rule.keywords)) {
        const matched = rule.keywords.some((kw) => {
          const cleanKw = kw.toLowerCase().trim();
          // Match whole word or substring
          return lower === cleanKw || lower.includes(` ${cleanKw} `) || lower.startsWith(`${cleanKw} `) || lower.endsWith(` ${cleanKw}`) || lower === cleanKw;
        });
        if (matched) {
          return rule.reply;
        }
      }
    }
    return null;
  }

  async generateReply(messageText, senderUsername = 'user') {
    // 1. Check custom keyword rules first
    const ruleReply = this.findRuleMatch(messageText);
    if (ruleReply) {
      return { text: ruleReply, source: 'rule' };
    }

    // 2. Check if AI replies are enabled
    const enableAI = process.env.ENABLE_AI !== 'false';
    if (enableAI) {
      const aiReply = await aiService.getReply(messageText, senderUsername);
      if (aiReply) {
        return { text: aiReply, source: 'groq-ai' };
      }
    }

    return null;
  }
}

module.exports = new ReplyEngine();
