const fs = require('fs');
const path = require('path');
const aiService = require('./aiService');
const db = require('./db');

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
    // 1. Check if user is blocked
    const profile = await db.getUserProfile(senderUsername);
    if (profile && profile.is_blocked) {
      console.log(`🚫 [Blocked User] Ignoring message from @${senderUsername}`);
      return null;
    }

    // 2. Check Auto Reply global setting
    const autoReplyEnabled = (await db.getSetting('auto_reply_enabled', 'true')) === 'true';
    if (!autoReplyEnabled) {
      return null;
    }

    // 3. Check custom keyword rules (Saved Model) if enabled
    const savedModelEnabled = (await db.getSetting('saved_model_enabled', 'true')) === 'true';
    if (savedModelEnabled) {
      const ruleReply = this.findRuleMatch(messageText);
      if (ruleReply) {
        return { text: ruleReply, source: 'rule' };
      }
    }

    // 4. AI Replies (Groq AI with User History & Personalized Persona)
    const groqAiEnabled = (await db.getSetting('groq_ai_enabled', 'true')) === 'true';
    const enableAI = process.env.ENABLE_AI !== 'false' && groqAiEnabled;
    if (enableAI) {
      const history = await db.getUserHistory(senderUsername, 6);
      const globalPersona = await db.getSetting('global_persona', 'sweet');

      const aiReply = await aiService.getReply(messageText, senderUsername, {
        profile,
        history,
        globalPersona
      });

      if (aiReply) {
        return { text: aiReply, source: `groq-ai (${profile.persona || globalPersona})` };
      }
    }

    return null;
  }
}

module.exports = new ReplyEngine();
