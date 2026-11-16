# 📸 Insta-Bot (Instagram Smart Auto-Reply & DM Bot)

An automated Instagram Direct Message (DM) & Auto-Reply bot powered by **Node.js**, **Instagram Private API**, and **Groq AI (LLaMA/Qwen)**.

---

## ✨ Features

- **🔐 2FA & OTP Checkpoint Support:** First-time login automatically detects Two-Factor Authentication (2FA) or Checkpoint Challenges and prompts for the SMS / Authenticator OTP directly in the terminal.
- **💾 Session Persistence:** Saves session cookies to `session.json` so you only have to log in once. Avoids repeated logins and security flags.
- **⚡ Fast Keyword Rules:** Instant FAQ replies based on custom keywords defined in `rules.json`.
- **🧠 Smart AI Fallback:** Powered by Groq AI (`qwen/qwen3.8-27b` / `llama-3.3-70b-versatile`) with customizable personality (like AAIRA).
- **🛡️ Anti-Ban Safeguards:**
  - Realistic typing delays before replying (2–4 seconds).
  - Automatically marks incoming messages as seen.
  - Per-user cooldown / rate limit to prevent spam.
- **🌐 Web Status Dashboard:** Built-in lightweight Express server showing bot health and reply statistics.

---

## 🚀 Quick Setup

### 1. Configure Credentials
Edit the `.env` file in the project root:
```env
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password

BOT_NAME=AAIRA
OWNER_NAME=Vishal

ENABLE_AI=true
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=qwen/qwen3.8-27b

POLL_INTERVAL=15000
PORT=3005
```

### 2. Start the Bot
```bash
node index.js
```

### 3. First-Time Login (OTP Handling)
- When you first run the bot, Instagram may send an **SMS OTP** or require **2FA**:
```
🔐 [Instagram] 2FA Required! Two-Factor Authentication is enabled.
📩 A 2FA verification code was sent.
👉 Please enter the 6-digit 2FA OTP code: 
```
- Simply enter the OTP in the terminal and press `Enter`.
- Once verified, `session.json` is generated. On subsequent runs, the bot restores the session automatically without asking for login or OTP again!

---

## 🏃‍♂️ Running in Background (PM2)

To keep the bot running 24/7 on your server:

```bash
# Start bot with PM2
pm2 start index.js --name "insta-bot"

# View live logs
pm2 logs insta-bot

# Save PM2 process list
pm2 save
```

---

## ⚙️ Customizing Auto-Reply Rules

Edit `rules.json` to add or edit custom keyword responses:

```json
[
  {
    "keywords": ["hi", "hello", "hey"],
    "reply": "Hey there! 😊 Kaise ho aap? Main Vishal ki AI assistant hu."
  },
  {
    "keywords": ["help", "support"],
    "reply": "Ji bataiye, aapko kis cheez me help chahiye? ✨"
  }
]
```

If a user message doesn't match any keyword in `rules.json`, the bot automatically delegates to **Groq AI** to generate a natural, conversational response!

---

## 📊 Status API

Open `http://localhost:3005` in your browser or curl:
```bash
curl http://localhost:3005
```
Response:
```json
{
  "name": "Instagram Auto-Reply Bot",
  "stats": {
    "startedAt": "2026-11-16T02:00:00.000Z",
    "totalRepliesSent": 12,
    "lastPollAt": "2026-11-16T02:05:00.000Z",
    "status": "active"
  }
}
```
