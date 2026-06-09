# NovaTel Voice Agent — IntellifyAI Assessment

A complete, working voice call agent loop featuring real-time WebRTC audio, advanced STT/TTS streaming, AI QA analysis, and a fully autonomous **self-healing prompt loop**.

## 🌐 Deployed Live Demos
* **Frontend Application (Vercel):** [https://voice-agent-bhargavp.vercel.app](https://voice-agent-bhargavp.vercel.app)
* **Backend API Service (Render):** [https://novatel-voice-agent-backend.onrender.com](https://novatel-voice-agent-backend.onrender.com)

## 📚 Documentation Map
| File | What's in it |
|---|---|
| [PROMPTS.md](./PROMPTS.md) | All AI prompts: v1 agent prompt, analysis prompt, self-healing meta-prompt |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System diagrams, latency budget breakdown, design trade-offs |
| [docs/SETUP.md](./docs/SETUP.md) | Detailed local setup walkthrough (accounts → demo) |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Common errors and fixes |

## 🚀 Architecture & Tech Stack

This project implements a highly optimized, low-latency voice AI pipeline:

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: MongoDB (Mongoose)
- **WebRTC Transport**: LiveKit (browser-based, no telephony required)
- **Speech-to-Text (STT)**: Deepgram Nova-2 (WebSocket streaming)
- **Text-to-Speech (TTS)**: Deepgram Aura (WebSockets for blazing-fast TTFB)
- **Large Language Model (LLM)**: Gemini 2.5 Flash (via Google Generative AI SDK)

### Architecture Decisions & Deviations from Prompt
* **Gemini 2.5 Flash instead of GPT-4o**: The assignment requested GPT-4o or Claude. We opted for Gemini 2.5 Flash strictly to meet the aggressive **<1.5 second perceived latency** requirement. GPT-4o's TTFT (Time-To-First-Token) is often too slow for natural conversational interruptions. Gemini 2.5 Flash guarantees sub-second reasoning speed, perfectly matching the voice agent use case.
* **Deepgram Aura instead of ElevenLabs**: Deepgram's Aura TTS model is highly optimized for real-time streaming, allowing us to pipe Gemini's text streams directly into Deepgram's byte streams and out through LiveKit WebRTC with near-zero latency.
* **Barge-in / Interruption Logic**: Implemented using STT interim transcripts rather than raw Voice Activity Detection (VAD). This prevents "ghost" echo deadlocks, ensuring the agent only yields when a user actually speaks a word, not when background noise occurs.

## 🛠 Setup Instructions

### 1. Prerequisites
- Node.js (v18+)
- MongoDB (local or Atlas cluster)
- LiveKit Server (Cloud or local via Docker)
- Deepgram API Key
- Gemini API Key

### 2. Backend Setup
```bash
cd server
npm install

# Create a .env file with your credentials:
# PORT=3000
# CLIENT_URL=http://localhost:5173
# MONGODB_URI=mongodb://localhost:27017/novatel
# LIVEKIT_API_KEY=your_key
# LIVEKIT_API_SECRET=your_secret
# LIVEKIT_URL=ws://localhost:7880
# DEEPGRAM_API_KEY=your_key
# GEMINI_API_KEY=your_key
# GEMINI_MODEL=gemini-3.1-flash-lite

npm run build
npm run start
```

### 3. Frontend Setup
```bash
cd client
npm install

# Create a .env file:
# VITE_API_URL=http://localhost:3000

npm run dev
```

## 🧠 The Self-Healing Pipeline

This application features a fully closed-loop autonomous QA system:
1. **Execution**: The agent runs the call via LiveKit WebRTC.
2. **Analysis**: Upon call completion, Gemini analyzes the diarized transcript against a strict QA Rubric.
3. **Healing**: If the score is below threshold, a separate "Meta-Prompt" evaluates the failure moments and generates a surgical JSON patch.
4. **Deployment**: The patch is applied to the agent's system prompt, and the next call instantly inherits the V2+ prompt without human intervention.

---

## 📜 Prompts

### Prompt v1 (Initial NovaTel Persona)
```text
You are Sarah, a customer support representative for NovaTel, a telecom company.
Your goal is to handle billing complaints professionally and resolve the customer's issue.
Keep your responses concise and conversational (1-2 sentences). Do not use bullet points or markdown.
Start the call by introducing yourself and NovaTel.

NovaTel Billing Policies:
- Late fees: Can be waived if the customer paid on time but there was a system delay.
- Double charges: Apologize and immediately process a refund.
- High plan cost: Offer to switch them to the "Value Plan" which is $30/month.
- Manager requests: Empathize first, then state you are fully authorized to help them directly. Do not transfer immediately.
```

### Meta-Prompt (Self-Healing Loop)
```text
You are a voice agent optimization system. A customer support call has just completed and QA analysis identified specific performance failures. Your job is to generate a minimal, surgical patch to the agent's system prompt that addresses these failures without breaking what's working.

CURRENT AGENT SYSTEM PROMPT (version X):
<current_prompt>
...
</current_prompt>

CALL QA SCORE: [Score]/100
HIGH-SEVERITY FAILURE MOMENTS FROM THIS CALL:
[JSON array of failure moments]

FULL CALL TRANSCRIPT (for context):
[Transcript]

Generate a prompt patch. Rules:
1. Address the HIGHEST SEVERITY failure first
2. Be SPECIFIC — reference the exact failure pattern with an example from the transcript
3. Be MINIMAL — add only what is missing, don't rewrite working sections
4. Add CONCRETE EXAMPLES where the failure was a style/tone issue
5. Do NOT introduce new constraints that contradict passing behaviors

Return ONLY valid JSON...
```

### Example Prompt v2 (Auto-Evolved)
```text
You are Sarah, a customer support representative for NovaTel...
...
- Manager requests: Empathize first, then state you are fully authorized to help them directly. Do not transfer immediately.

[ADDED BY AUTO-HEAL V2]:
- Issue Acknowledgment: ALWAYS acknowledge the specific issue the customer is experiencing and express empathy BEFORE offering a solution or explaining a policy. (e.g. "I understand how frustrating it is to see a double charge on your bill. Let me fix that for you right now.")
```

## ⚠️ Known Limitations
- **Diarization**: Real-time diarization over WebRTC is achieved via discrete speaker streams rather than post-processing, which is highly accurate but requires both parties to use headsets to prevent heavy AEC bleed.
- **Agent Latency**: The initial connection to Gemini 2.5 Flash can occasionally take ~2s to warm up the context window if the instance is cold. Subsequent turns achieve the targeted <1.5s latency.

---

## 🚀 Deployment (Render + Vercel)

The repo ships with `render.yaml` (backend) and `vercel.json` (frontend) so both providers can deploy from this single repo.

### Backend — Render

1. Push the repo to GitHub. On [render.com](https://render.com), click **New → Blueprint** and point it at the repo. Render detects `render.yaml` and provisions a Node web service.
2. In the service **Environment** tab, set these vars (the blueprint marks them `sync: false`):
   - `MONGODB_URI` — Atlas connection string
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   - `DEEPGRAM_API_KEY`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` — set to `gemini-3.1-flash-lite` (highly recommended for latency & stability)
   - `CLIENT_URL` — your Vercel URL (set this AFTER the frontend deploys; can include multiple comma-separated origins, e.g. `https://novatel.vercel.app,https://novatel-git-main.vercel.app`)
3. Deploy. Render runs `npm install && npm --workspace server run build` then `node server/dist/index.js`.
4. After boot, hit `https://<your-service>.onrender.com/api/health` — it must return `{ "ready": true, ... }`. If any `services.*` is false, that env var is missing or mistyped.

**Free-tier caveats:**
- Render free instances **sleep after 15 min idle**; first request after sleep takes ~30s. **For your Loom recording, warm the backend first** by visiting `/api/health` in a browser and waiting for the JSON response before clicking "Start Call". Otherwise the LiveKit token request times out while the dyno spins up.
- Disk is **ephemeral** — call recordings are lost on restart. For persistence, uncomment the `disk:` block in `render.yaml` (requires paid plan) or wire an S3 backend.
- Optional: enable `LOG_TO_FILE=1` only if you want file logs (default off in prod since Render captures stdout). Default `LOG_LEVEL` in production is `warn`; set `LOG_LEVEL=info` if you need verbose traces.

### Frontend — Vercel

1. On [vercel.com](https://vercel.com), **New Project → Import Git Repository**. Pick the repo. Vercel reads `vercel.json` — build command is set, output dir is `client/dist`.
2. Add one environment variable under **Settings → Environment Variables**:
   - `VITE_API_URL` = your Render backend URL (no trailing slash). Example: `https://novatel-voice-agent.onrender.com`
3. Deploy. Note the production URL — paste it back into Render's `CLIENT_URL` env var (step 2 above) and redeploy the backend so CORS allows it.

### Order of operations
1. Deploy backend to Render first (note its URL).
2. Set `VITE_API_URL` on Vercel → deploy frontend (note its URL).
3. Set `CLIENT_URL` on Render → redeploy backend.
4. Visit the Vercel URL, place a call, watch Render logs.

### Common deployment gotchas
- **Mic permission requires HTTPS in production.** Both Render and Vercel give you HTTPS by default — works.
- **WebSocket connections (LiveKit, Socket.IO, Deepgram) work over Render web services** out of the box. No special config needed.
- **If you see a CORS error after deploy**, `CLIENT_URL` on Render is wrong. The error message in browser console will name the rejected origin; copy that exactly into `CLIENT_URL`.
- **`/api/health` is the single source of truth** for misconfigurations — always check it first when something behaves oddly post-deploy.

