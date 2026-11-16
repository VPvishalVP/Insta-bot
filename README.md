# 📸 Insta-Bot (Personalized Multi-Persona Instagram DM Auto-Reply)

An advanced, intelligent Instagram Direct Message (DM) & Auto-Reply bot powered by **Node.js**, **Instagram Private API**, **Turso DB (@libsql/client)**, and **Groq AI (Qwen/LLaMA)**.

> 🔒 **Strict DM-Only Policy:** This bot is strictly scoped to **ONLY reply to incoming direct messages (DMs)**. It will never like feeds, follow/unfollow users, view stories, post comments, or perform unsolicited actions.

---

## 🌟 Advanced "Sabka Alag Mood" (Personalized) Features

- 🎭 **Persona Studio (Multi-Mood AI):**
  - 🌸 **AAIRA Sweet & Caring (Default):** Warm, feminine Hinglish assistant with cute emojis and friendly care.
  - 💼 **Professional & Business:** Crisp, respectful, ideal for business/brand collaboration inquiries.
  - 🔥 **Savage Roast & Banter:** Funny, witty, sarcastic punchlines for friends and entertaining chats.
  - 🤙 **Chill Bro / Buddy:** Relaxed, informal brotherly vibe.
- 👥 **Individual Per-User Memory (Sabka Context Alag):**
  - Turso DB stores multi-turn conversation history for every user (`insta_conversations`).
  - If a user mentions their name, hobby, or question, the bot remembers it in future messages!
- 🎯 **Automatic Lead & Contact Capture:**
  - Automatically detects when a user shares their phone number or email address in DM and saves it directly to Turso DB (`insta_user_profiles`).
- ⭐ **VIP & Block List Control:**
  - Mark specific friends as **VIP** for priority high-respect responses.
  - One-click **Block** to permanently ignore unwanted accounts.
- ✉️ **Manual Direct DM Sender:**
  - Send direct DMs to any Instagram user directly from the Web Dashboard without opening the Instagram app.
- 💾 **Turso Cloud Persistence:**
  - Sessions and user profiles are stored in Turso DB, keeping them safe across restarts or deployments.

---

## 🚀 Quick Setup & Web Dashboard

### 1. Web Dashboard (Recommended)
Open your Cloudflare tunnel dashboard link:
```
https://happy-tar-intensity-dodge.trycloudflare.com
```
1. Enter your Instagram Username and Password.
2. If 2FA or SMS OTP is required, the prompt appears right on the web page — enter the 6-digit OTP and click **Submit OTP**.
3. Once logged in, the bot starts monitoring DMs immediately!

### 2. Manual Terminal Start
```bash
cd /home/ipx/Insta-bot
pm2 start index.js --name "insta-bot"
```

---

## 📊 Live Web Dashboard Features

- **📊 Overview:** Live bot status, connected account, replies counter, leads counter, and live DM history.
- **🎭 Persona Studio:** Switch global AI personality with 1-click.
- **👥 Users & Leads:** View all users who messaged, their custom mood, VIP status, and auto-captured phone numbers.
- **✉️ Direct DM:** Send manual messages directly from the browser.
