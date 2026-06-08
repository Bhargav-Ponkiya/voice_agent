# Setup Guide — NovaTel Voice Agent

Complete step-by-step setup from a fresh clone to a working demo call.

If anything breaks, see [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

---

## Prerequisites

- **Node.js 18 or higher** — check with `node -v`
- **npm 9 or higher** — check with `npm -v`
- **A modern browser** — Chrome, Edge, or Firefox (Safari has Web Audio API quirks)
- **Working microphone** — system mic access enabled

---

## Step 1 — Create Free Accounts (~15 minutes)

All services have free tiers / free credits that cover the entire assessment demo (estimated ~$0.06 in usage, paid from free credits on signup).

### 1.1 LiveKit Cloud
1. Go to https://livekit.io/cloud
2. Sign up (Google/GitHub login is fastest)
3. Create a new project — name it `novatek-voice-agent`
4. From the project dashboard, copy these three values:
   - `LIVEKIT_URL` — e.g. `wss://novatek-xxxxx.livekit.cloud`
   - `LIVEKIT_API_KEY` — starts with `APIxxxxxxxxx`
   - `LIVEKIT_API_SECRET` — long random string
5. **Free tier:** 10,000 connection-minutes/month — plenty

### 1.2 Deepgram
1. Go to https://console.deepgram.com
2. Sign up
3. Navigate to **API Keys** → **Create a New API Key**
4. Permissions: leave default (`Member` is fine)
5. Copy the key (starts with random hex)
6. **Free credit:** $200 on signup — covers hundreds of demo calls

### 1.3 Google Gemini
1. Go to https://aistudio.google.com
2. Sign up
3. Click **Get API Key** and create a new key
4. Copy the key (starts with `AIzaSy`)
5. **Free tier:** 15 RPM (requests per minute) — plenty for demo calls

### 1.4 Deepgram Aura (TTS)
We use Deepgram's **Aura-2** Text-to-Speech engine for voice generation instead of ElevenLabs, which avoids the strict Free Tier IP/VPN blocks.
1. The TTS engine reuses the same **Deepgram API Key** that you generated in step 1.2.
2. No separate credentials, registration, or billing configuration is required for TTS!

### 1.5 MongoDB Atlas
1. Go to https://www.mongodb.com/cloud/atlas/register
2. Sign up
3. Create a free shared cluster (M0 — choose closest region)
4. Once cluster is ready:
   - Click **Database Access** → **Add New Database User** → username + password (save these!)
   - Click **Network Access** → **Add IP Address** → **Allow Access from Anywhere** (for development)
5. Click **Connect** on the cluster → **Drivers** → copy the connection string
6. Replace `<password>` with your DB user password
7. Add a database name before the `?` — e.g. `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/novatek-voice?retryWrites=true`
8. **Free tier:** 512MB — plenty (each call uses <10KB)

---

## Step 2 — Configure Environment

In the project root:

```bash
cp .env.example .env
```

Open `.env` in your editor and paste in all the values from Step 1.

**Validation checklist:**
- [ ] `LIVEKIT_URL` starts with `wss://`
- [ ] `LIVEKIT_API_KEY` starts with `API`
- [ ] `DEEPGRAM_API_KEY` is a hex string (no `sk-` prefix)
- [ ] `GEMINI_API_KEY` starts with `AIzaSy`
- [ ] `DEEPGRAM_API_KEY` is set (reused for both STT and TTS)
- [ ] `MONGODB_URI` has your real password (no `<password>` placeholder)

---

## Step 3 — Install Dependencies

From the project root:

```bash
npm install
```

This installs dependencies for both `server/` and `client/` workspaces (~2-3 minutes).

If you see warnings about peer dependencies, they're safe to ignore.

---

## Step 4 — Run the App

You need **two terminals** open.

### Terminal 1 — Backend
```bash
cd server
npm run dev
```

Expected output:
```
[2026-06-04T...] [INFO] MongoDB connected
[2026-06-04T...] [INFO] Seeded initial prompt v1
[2026-06-04T...] [INFO] Server running on port 3001
[2026-06-04T...] [INFO] Client URL: http://localhost:5173
```

If you see errors, see [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md#backend-wont-start).

### Terminal 2 — Frontend
```bash
cd client
npm run dev
```

Expected output:
```
VITE v5.x.x  ready in 500ms

➜  Local:   http://localhost:5173/
```

---

## Step 5 — Health Check

Before making your first call, verify all services are reachable:

```bash
curl http://localhost:3001/api/health | jq
```

Expected output:
```json
{
  "server": "ok",
  "mongodb": "connected",
  "services": {
    "livekit": true,
    "deepgram": true,
    "gemini": true,
    "mongodb": true
  },
  "timestamp": "2026-06-07T06:36:14.933Z",
  "ready": true
}
```

If `ready: false`, check which env var is `false` and re-verify Step 2.

---

## Step 6 — Make Your First Call

1. Open http://localhost:5173 in your browser
2. Click **Start Call**
3. **Allow microphone access** when prompted
4. Wait for Sarah (the agent) to greet you
5. Try one of these scenarios:
   - "My bill this month is wrong — I was charged twice"
   - "I want to cancel my plan, it's too expensive"
   - "Why was I charged a late fee? I paid on time"
   - "I want to speak to a manager"
6. Have a 30-60 second conversation
7. Click **End Call**
8. Wait ~10 seconds for analysis to complete
9. You'll be redirected to the dashboard with the full scorecard

---

## Step 7 — Verify the Self-Healing Loop

1. After Call 1 ends, go to the dashboard
2. Scroll to **Prompt Evolution** at the bottom
3. You should see **v1** and **v2** versions listed
4. Click v2 to expand — you'll see:
   - The patch summary
   - What failure it addressed
   - The diff vs v1
5. Now make a **second call** with similar scenario
6. The new call uses v2 automatically
7. Compare scores — the second call should score higher

If you don't see v2: the first call scored ≥90 (no patch needed) — try ending Call 1 abruptly without a resolution to force a low score.

---

## Common Setup Issues

### "Cannot find module 'livekit-server-sdk'" or similar
You haven't run `npm install` yet, or it failed partway. Run `npm install` again.

### "MongoDB connection failed"
Your `MONGODB_URI` is wrong. Common mistakes:
- Forgot to replace `<password>` with actual password
- Special chars in password not URL-encoded (use only alphanumeric)
- IP not allowlisted in Atlas → Network Access

### "Authentication failed" from Gemini
Check:
- Key starts with `AIzaSy`
- No trailing whitespace in `.env`

### Microphone not working
- Check browser console for permission errors
- Chrome: `chrome://settings/content/microphone` — allow `localhost`
- HTTPS not needed on `localhost` — `getUserMedia` works on `http://localhost`

### Agent never speaks
- Check Deepgram API key is valid and has not expired (powers BOTH STT and TTS)
- Check browser console for LiveKit connection errors (agent voice flows through the LiveKit room, not Socket.IO)
- In DevTools, confirm the WebRTC peer connection is "connected" and an inbound audio track is subscribed
- Server logs should show `[DeepgramTTS] Received audio chunk: NNN bytes` lines — if absent, TTS isn't producing audio

---

## Next Step

Verify each requirement works end-to-end, then record your Loom walkthrough demonstrating two calls (Call 1 with v1 prompt; Call 2 with the self-healed prompt).
