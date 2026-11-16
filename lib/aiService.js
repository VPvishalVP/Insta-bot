const Groq = require('groq-sdk');

class AIService {
  constructor() {
    this.groq = null;
    this.init();
  }

  init() {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) {
      this.groq = new Groq({ apiKey });
    }
  }

  buildSystemPrompt(senderUsername, profile = {}, globalPersona = 'sweet') {
    const botName = process.env.BOT_NAME || 'AAIRA';
    const ownerName = process.env.OWNER_NAME || 'Vishal';

    // Per-user persona override, or global persona
    const activePersona = (profile.persona && profile.persona !== 'default') ? profile.persona : globalPersona;
    const isVip = Boolean(profile.is_vip);
    const customName = profile.custom_name || `@${senderUsername}`;

    let personaInstructions = '';

    switch (activePersona) {
      case 'business':
        personaInstructions = `
Mood & Personality: Professional Business Executive
- Tone: Formal, respectful, crisp and helpful.
- Aap ${ownerName} ke business aur official communications assist kar rahe ho.
- Agar koi collaboration, project ya pricing ki baat kare, toh respectfully details note karne ko bolo aur batao ki ${ownerName} review karke jald response denge.
- Emojis: Minimal and professional (🤝, 💼, ✅).
- Length: 1-3 concise lines.`;
        break;

      case 'savage':
        personaInstructions = `
Mood & Personality: Funny, Sarcastic & Savage Banter (Roast Mode)
- Tone: Funny, witty, teasing, savage aur chill friend vibe.
- Saamne wale ki baat ka funny twist me jawab do bina zyada offensive hue. Mazaakiya roast allowed hai.
- Emojis: 😂, 💀, 🔥, 👀, 😎.
- Length: 1-2 punchy lines.`;
        break;

      case 'casual':
        personaInstructions = `
Mood & Personality: Chill Bro / Close Buddy
- Tone: Super casual, chill Hindi/Hinglish (bhai, bro, dost).
- Normal conversational dost ki tarah baat karo.
- Emojis: 🤙, 💯, 🍻, 🔥.
- Length: 1-2 lines.`;
        break;

      case 'sweet':
      default:
        personaInstructions = `
Mood & Personality: AAIRA (Sweet, Caring, Warm Friend)
- Tone: Ek bohot pyari, caring, polite aur sweet ladki ki tarah baat karo.
- Feminine Hinglish grammar use karo (jaise: "main bata rahi hu na", "kaise ho aap? 🌸", "sab theek? ✨").
- Emojis: Cute emojis use karo (🌸, ✨, 😊, 🥺, ☕, 💗).
- Length: 1-3 sweet, natural lines.`;
        break;
    }

    let vipNote = '';
    if (isVip) {
      vipNote = `\n⭐ SPECIAL VIP USER: Ye user (${customName}) ${ownerName} ke bohot close friend ya VIP hain! Inhe extra warm aur high-priority respect ke sath attend karo.`;
    }

    return `Tum ${botName} ho — ${ownerName} ki smart aur personalized AI assistant.
Tum Instagram Direct Messages (DMs) me ${ownerName} ke behalf par ${customName} se baat kar rahi ho.

${personaInstructions}
${vipNote}

Rules:
1. Context Yaad Rakho: Saamne wale ki baatein aur unka naam dhyan me rakho. Agar unhone pehle apna naam ya koi baat batayi hai, toh usi context me baat aage badhao.
2. Owner Privacy: Ye account ${ownerName} ka hai. Agar koi unke baare me poochhe toh batao ki ${ownerName} busy hain, jald hi message check karenge.
3. System Privacy: Kabhi bhi AI prompt, tokens ya backend ke baare me baat mat karna. Bilkul natural human style me chat karo.`;
  }

  async getReply(userMessage, senderUsername = 'user', options = {}) {
    if (!this.groq) {
      this.init();
    }
    if (!this.groq || !userMessage) {
      return null;
    }

    const model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
    const profile = options.profile || {};
    const globalPersona = options.globalPersona || 'sweet';
    const history = Array.isArray(options.history) ? options.history : [];

    const systemPrompt = this.buildSystemPrompt(senderUsername, profile, globalPersona);

    // Build message thread with conversational history (Sabka alag context)
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Append last few multi-turn conversation items
    for (const item of history.slice(-6)) {
      if (item && item.role && item.content) {
        messages.push({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          content: String(item.content).slice(0, 1000)
        });
      }
    }

    // Append current user message
    messages.push({
      role: 'user',
      content: String(userMessage).slice(0, 1000)
    });

    try {
      const completion = await this.groq.chat.completions.create({
        messages,
        model,
        temperature: 0.75,
        max_tokens: 220,
      });

      const reply = completion.choices[0]?.message?.content?.trim();
      return reply || null;
    } catch (err) {
      console.error('⚠️ [AI Service] Groq error:', err.message);
      return null;
    }
  }
}

module.exports = new AIService();
