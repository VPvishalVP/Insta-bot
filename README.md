# 📸 Insta-Bot (Instagram Smart Auto-Reply & DM Bot)

An automated Instagram Direct Message (DM) & Auto-Reply bot powered by **Node.js**, **Instagram Private API**, **Turso DB (@libsql/client)**, and **Groq AI (Qwen/LLaMA)**.

> 🔒 **Strict DM-Only Policy:** This bot is strictly scoped to **ONLY reply to incoming direct messages (DMs)**. It will never like feeds, follow/unfollow users, view stories, post comments, or perform unsolicited actions.

---

## ✨ Features

- **📩 Message-Only Auto-Reply:** Strictly handles incoming 1-on-1 direct text messages. Ignores spam, system notifications, media-only messages, and external actions.
- **🗄️ Turso Database Integration (`@libsql/client`):**
  - Keeps track of all processed messages and replies in a cloud Turso database (`insta_messages`).
  - Persists Instagram session cookies in Turso DB (`insta_sessions`) so the bot doesn't lose login state across restarts or different machines.
- **🔐 2FA & OTP Checkpoint Support:** Prompts in the terminal for the SMS OTP or 2FA code during the first login.
- **⚡ Fast Keyword Rules:** Instant FAQ replies based on custom keywords defined in `rules.json`.
- **🧠 Smart AI Fallback:** Powered by Groq AI (`qwen/qwen3.8-27b` / `llama-3.3-70b-versatile`) with customizable personality (like AAIRA).
- **🛡️ Anti-Ban Safeguards:**
  - Realistic typing delays before replying (2–4 seconds).
  - Automatically marks incoming messages as seen.
  - Per-user cooldown (8s minimum) to prevent rapid loops.
- **🌐 Web Status Dashboard:** Built-in Express server showing bot health, Turso DB connection, and reply statistics.

---

## 🚀 Quick Setup

### 1. Configure Credentials
Edit the `.env` file in the project root:
```env
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password

# Turso Cloud Database
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token

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
- Enter the OTP in the terminal and press `Enter`.
- Once verified, the session is saved directly to **Turso DB** and local `session.json`. Next time, it will auto-restore with zero prompts!

---

## 🏃‍♂️ Running in Background (PM2)

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
  "name": "Instagram DM Auto-Reply Bot",
  "policy": "Only replies to incoming text messages",
  "database": "Turso DB",
  "stats": {
    "startedAt": "2026-11-16T03:10:00.000Z",
    "totalReplies": 15,
    "lastPollAt": "2026-11-16T03:15:00.000Z",
    "status": "active"
  }
}
```
