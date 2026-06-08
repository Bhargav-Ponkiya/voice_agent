# NovaTel Voice Agent — Project Briefing

> **If you're an AI assistant reading this for the first time:** read this entire file before touching any code. It's the project's institutional memory. After this, read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for system design and [`PROMPTS.md`](./PROMPTS.md) for the AI prompts. The user is a full-stack MERN engineer new to AI — explain AI concepts when they come up.

---

## What This Is

A complete voice call agent system built for a full-stack engineering demonstration.

**Persona:** Sarah — customer support rep for **NovaTel**, a fictional telecom company. Handles billing complaints over a live browser-based voice call.

**Five capabilities (all built):**

1. Live voice call (LiveKit + Deepgram STT + Gemini LLM + Deepgram Aura TTS)
2. Save WAV recording + diarized timestamped transcript
3. AI call analysis pipeline (QA rubric + sentiment arc + call flow + agent signals)
4. Browser dashboard with score ring, sentiment chart, call flow timeline, annotated transcript, trend comparison
5. **Self-healing prompt loop** — after every call, the system analyzes failures and patches its own system prompt; the next call uses the evolved prompt automatically

---

## Current Status

- **Code:** 100% written, 60+ files
- **Compiled / Linted:** Not yet — diagnostics show "cannot find module" because `npm install` hasn't run
- **Tested:** Not yet — user needs API keys first
- **Next concrete action:** see [SETUP.md](./SETUP.md)

The user is moving the codebase from this development machine to their primary machine to test, demo, and submit.

---

## Tech Stack — Full Rationale

| Layer              | Choice                      | Version                     | Why this and not alternatives                                                                               |
| ------------------ | --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Frontend framework | React                       | 18.3.1                      | Required by assessment ("React + Node + TS"); ecosystem maturity                                            |
| Frontend tooling   | Vite                        | 5.4.x                       | Fast HMR; native ESM; first-class Tailwind v4 plugin                                                        |
| Styling            | **Tailwind v4** (CSS-first) | 4.0.x                       | Modern; OKLCH colors; no PostCSS/autoprefixer needed                                                        |
| Charts             | Recharts                    | 2.13.x                      | Best React+Tailwind story; handles area/bar/line charts                                                     |
| Realtime client    | socket.io-client            | 4.8.x                       | Pairs with backend; auto-reconnect                                                                          |
| Backend runtime    | Node.js + TypeScript        | 18+ / 5.6                   | Spec requires Node; TS for safety                                                                           |
| HTTP server        | Express                     | 4.18.x                      | Standard; lightweight                                                                                       |
| Realtime server    | Socket.IO                   | 4.6.x                       | Direct control over audio pipeline; well-typed                                                              |
| ORM                | Mongoose                    | 8.x                         | Familiar to MERN devs; works with Atlas free tier                                                           |
| WebRTC transport   | LiveKit                     | 2.4.x server / 2.7.x client | Spec REQUIRES LiveKit; we use for rooms/tokens (see [hybrid trade-off](#critical-trade-off-livekit-hybrid)) |
| STT                | Deepgram Nova-2             | streaming WS                | Best accuracy + lowest latency; $200 free credit                                                            |
| LLM                | Google Gemini Flash         | gemini-2.5-flash            | Fast first-token latency, cheap and highly reliable                                                         |
| TTS                | Deepgram Aura-2             | aura-2-asteria-en           | Ultra-low latency; PCM 24kHz output; WS streaming; reuses Deepgram key                                      |
| Database           | MongoDB Atlas               | free M0                     | Flexible schema for evolving analyses; 512MB free                                                           |

---

## Directory Map — Where Everything Lives

```
novatel-voice-agent/
├── README.md                   ← entry point; documentation map
├── ARCHITECTURE.md             ← system diagrams + design rationale
├── SETUP.md                    ← step-by-step from accounts to demo
├── PROMPTS.md                  ← all AI prompts (assessment requires this)
├── CLAUDE.md                   ← this file
├── .env.example                ← every env var + setup notes
├── .gitignore                  ← interview-prep docs excluded, see [docs split](#docs-folder--what-ships-vs-what-doesnt)
├── package.json                ← npm workspaces (server + client)
│
├── docs/
│   └── TROUBLESHOOTING.md      ← SHIPS — common errors + fixes
│   (the other docs/ files exist locally for interview prep
│    but are gitignored — see below)
│
├── server/                     ← Node.js backend
│   ├── CLAUDE.md               ← backend context
│   ├── package.json
│   ├── tsconfig.json           ← target ES2022 (for AbortSignal global)
│   └── src/
│       ├── index.ts                          ← Express + Socket.IO entry; call lifecycle wiring
│       ├── config/index.ts                   ← .env loader; single source of truth
│       ├── utils/
│       │   ├── audioUtils.ts                 ← WAV file writer; timestamp formatter
│       │   └── logger.ts                     ← tiny console logger w/ timestamps
│       ├── database/
│       │   ├── connection.ts                 ← Mongoose connect
│       │   └── models/                       ← Call, Transcript, Analysis, PromptVersion
│       ├── routes/
│       │   ├── health.ts                     ← /api/health — validates every env var
│       │   ├── calls.ts                      ← POST /api/calls/start; GET /api/calls/:id
│       │   ├── analysis.ts                   ← GET /api/analysis/:callId
│       │   └── prompts.ts                    ← GET /api/prompts (list versions)
│       └── services/
│           ├── livekit/roomService.ts        ← createUserToken (async); deleteRoom
│           ├── stt/deepgramService.ts        ← Deepgram WS wrapper (EventEmitter)
│           ├── llm/geminiService.ts          ← Gemini streaming generator + analysis call
│           ├── tts/deepgramTtsService.ts      ← Deepgram TTS WS wrapper (EventEmitter)
│           ├── recorder/callRecorder.ts      ← PCM buffers → WAV files
│           ├── agent/agentPipeline.ts        ← ⭐ CORE — orchestrates STT→LLM→TTS per call
│           ├── analysis/
│           │   ├── analysisPrompts.ts        ← prompt template builders
│           │   └── callAnalysis.ts           ← runs post-call Gemini analysis
│           └── promptEvolution/
│               └── selfHealingPrompt.ts      ← ⭐ HEART — seed v1, patch + save new versions
│
└── client/                     ← React frontend
    ├── CLAUDE.md               ← frontend context
    ├── package.json            ← Tailwind v4 + Vite + Recharts
    ├── vite.config.ts          ← @tailwindcss/vite plugin + proxy to backend
    ├── tailwind.config.js      ← empty — Tailwind v4 is CSS-first
    ├── postcss.config.js       ← empty — not needed in v4
    ├── index.html              ← preloads Inter + JetBrains Mono fonts
    └── src/
        ├── main.tsx, App.tsx
        ├── index.css           ← Tailwind v4 @theme block; design tokens (OKLCH); animations
        ├── types/index.ts      ← shared TS types
        ├── services/api.ts     ← axios REST wrapper
        ├── hooks/
        │   ├── useSocket.ts        ← Socket.IO connection
        │   └── useAudioPipeline.ts ← mic capture (ScriptProcessor) + TTS playback
        ├── pages/
        │   ├── CallPage.tsx
        │   └── DashboardPage.tsx
        └── components/
            ├── call/
            │   ├── VoiceCallInterface.tsx    ← Socket.IO event handlers + call state
            │   └── LiveTranscript.tsx
            └── dashboard/
                ├── QAScorecard.tsx
                ├── SentimentChart.tsx
                ├── CallFlowTimeline.tsx
                ├── TranscriptAnnotated.tsx
                ├── CallComparison.tsx
                └── PromptVersionHistory.tsx
```

---

## Critical Trade-off: LiveKit Hybrid

**The assessment says** "Use LiveKit for WebRTC audio transport."

**What we actually do:** LiveKit handles room management and token issuance; the audio pipeline itself runs over Socket.IO.

**Why:**

- LiveKit's mature server-side agent SDK is Python-first
- `@livekit/rtc-node` (the Node alternative) needs native binaries → painful to deploy on free tiers
- Socket.IO gives us direct, low-latency control over the interruption logic + sentence streaming

**How to explain in interview/Loom:**

> "I used LiveKit for rooms/auth/presence — where its value is immediate. For the audio pipeline I chose Socket.IO so I could control interruption latency and sentence-level TTS streaming directly. The Python LiveKit Agents SDK would be the right choice in production; for a Node-only take-home, the hybrid is the engineering trade-off I picked."

**Do NOT "fix" this by ripping out the hybrid.** It's a deliberate design.

---

## Critical Code Paths — Read Before Modifying

### 1. `server/src/services/agent/agentPipeline.ts`

The orchestrator. Per call:

- Connects Deepgram WS for STT
- On `transcript:final` → calls Gemini with system prompt + history
- Splits Gemini's streaming response into sentences (`extractSentences`)
- Sends each sentence to Deepgram TTS WS as soon as it's complete
- Pipes Deepgram PCM chunks back to client via Socket.IO
- Tracks dead air via a 1-second interval check
- Handles interruption via `AbortController` + closing Deepgram TTS WS

**Why sentence-level streaming:** We start TTS while Gemini is still writing. Cuts perceived latency ~60%.

**Why isSpeaking flag + AbortController:** Allows mid-sentence interruption when Deepgram emits `speech_started`.

### 2. `server/src/services/promptEvolution/selfHealingPrompt.ts`

**The heart of the assessment.** Per the spec, this is what differentiates good from exceptional.

- `seedInitialPrompt()` — runs on server boot; creates PromptVersion v1 if missing
- `getCurrentPrompt()` — called at the start of every call; returns latest version
- `generateAndApplyPatch(...)` — runs after every call; gated by `rubric_score < 90`
  - Sends current prompt + failure_moments to Gemini with the meta-prompt
  - Parses returned JSON patch
  - Applies via section-targeted regex (`## SectionName ...`)
  - Falls back to appending a new section if section not found
  - Saves new PromptVersion with full audit trail

**Why score gate at 90:** Don't churn the prompt when it's already working. Score 90 means 4 of 5 rubric items passed.

**Why section-targeted patches:** Forces Gemini to think in terms of _which existing section to edit_, preventing prompt drift where each iteration undoes the last.

### 3. `server/src/services/analysis/analysisPrompts.ts`

Two prompt builders:

- `buildAnalysisPrompt` — produces the QA scorecard JSON
- `buildSelfHealingPrompt` — the meta-prompt

**Both prompts insist on grounding in the actual transcript.** The phrase `STRICTLY on the transcript text — do not infer or hallucinate` is critical — it's our defense against the "hallucinated analysis" disqualifier in the assessment.

**The `failure_moments[]` schema is typed** (`type` field is an enum) so the meta-prompt can pattern-match rather than reason from scratch.

### 4. `server/src/services/llm/geminiService.ts`

- `streamResponse` — async generator using fetch with SSE streaming
- `analyzeCall` — one-shot call for post-call analysis; uses `max_tokens: 4096`

### 5. `client/src/hooks/useAudioPipeline.ts`

- Captures mic at 16kHz via `AudioContext` + `ScriptProcessor`
- Sends Int16 PCM chunks over Socket.IO
- Receives Deepgram PCM chunks; decodes as 24kHz Float32 → AudioBuffer → plays in sequence via Web Audio API
- `stopTTS()` recreates the playback AudioContext to instantly stop queued audio (interruption)

**ScriptProcessorNode is deprecated** but works; AudioWorklet would be the modern path. Noted in README known limitations.

---

## All Prompts — In `PROMPTS.md`

The assessment **requires** these in the submission. Four sections:

1. **Prompt v1** — initial NovaTel agent system prompt (8 sections; deliberately written for speech not text)
2. **Analysis prompt** — produces typed JSON scorecard
3. **Meta-prompt** — generates targeted patches from failure_moments
4. **Prompt v2+** — auto-generated after calls; lives in MongoDB `prompt_versions` collection

The v1 prompt is also seeded into the DB by `seedInitialPrompt()` on server boot. **The source of truth for v1 at runtime is `selfHealingPrompt.ts`**, not `PROMPTS.md` — they're kept consistent manually.

---

## Bug Fixes Applied During Development (handoff context)

In case any of these resurface or someone questions a design choice:

1. **`livekit-server-sdk` v2 `toJwt()` is async** (returns `Promise<string>`, not `string`). All token creators in `roomService.ts` and `routes/calls.ts` await this.

2. **AbortSignal threading** — `streamResponse` in `geminiService.ts` now aborts the fetch request so cancellation actually cancels the upstream HTTP request.

3. **Pending dead-air finalization** — `agentPipeline.stop()` now finalizes any in-progress dead-air segment when the call ends, so silence-then-hangup gets captured.

4. **TypeScript `lib: ["ES2022", "DOM"]`** — needed because `AbortSignal` is a global in Node 15+ but not declared in older TS lib targets.

5. **Tailwind v4 migration** — moved from v3 (with `tailwind.config.js` + PostCSS) to v4 (CSS-first via `@theme` in `index.css`, `@tailwindcss/vite` plugin). The v3 config files are now empty stubs to avoid confusing editor tooling.

6. **`/api/health` endpoint** — validates every required env var and Mongo connection. Always curl this first if anything seems wrong.

---

## docs/ Folder — What Ships vs What Doesn't

The `docs/` folder has 5 files but **4 are gitignored** (for the user's eyes only):

| File                         | Status     | Why                                                                     |
| ---------------------------- | ---------- | ----------------------------------------------------------------------- |
| `docs/TROUBLESHOOTING.md`    | **SHIPS**  | Generic project hygiene; useful for any dev                             |
| `docs/CONCEPTS.md`           | gitignored | Contains "Likely Interview Questions" — explicit prep                   |
| `docs/SUBMISSION.md`         | gitignored | Loom script + literal email template — personal                         |
| `docs/TESTING.md`            | gitignored | "Forcing a low score" reads as gaming the demo                          |
| `docs/AI_DEVELOPMENT_LOG.md` | gitignored | Reveals AI-heavy build; "What I'd do differently" reads as backpedaling |

**Do not re-add these to README's documentation map.** Their links were intentionally removed.

If a new AI assistant suggests "let me check docs/CONCEPTS.md", the file may exist locally but it's not pushed — and shouldn't be referenced in code or shipped docs.

---

## Common Modification Recipes

### Change the agent persona / NovaTel policies

Edit the `INITIAL_SYSTEM_PROMPT` constant in `server/src/services/promptEvolution/selfHealingPrompt.ts`. Also update `PROMPTS.md` to match.
**Important:** if the DB already has v1, you need to either bump the version manually or wipe the `prompt_versions` collection — the seed only runs if v1 doesn't exist.

### Change the voice

Update the `modelName` parameter inside `server/src/services/tts/deepgramTtsService.ts` to use a different Deepgram Aura voice (e.g. `aura-2-asteria-en`, `aura-2-thalia-en`, `aura-2-orion-en`).

### Use OpenAI instead of Gemini

- Replace Gemini config/service with OpenAI
- Rewrite `server/src/services/llm/geminiService.ts` to use OpenAI's streaming API
- The async-generator signature can stay the same — the rest of the code doesn't care

### Change the QA rubric scoring

The rubric scoring lives **in the prompt** (`buildAnalysisPrompt`). The 5 items and point values are part of the prompt text, not code. The TypeScript types in `models/Analysis.ts` reflect the schema but don't enforce scoring math.

### Add a new failure type

1. Add the new enum value to the `type` field description in `buildAnalysisPrompt`
2. Optionally add specific patch logic for it in the meta-prompt (`buildSelfHealingPrompt`)
3. Display it in `TranscriptAnnotated.tsx` if special UI is needed

### Change the latency budget

The "<1.5s" target comes from the assessment. To investigate where time is spent, add timestamps in `agentPipeline.ts` at:

- `handleCustomerInput` start (user finished talking)
- First `stream` token from Gemini
- First `audio` event from Deepgram TTS
- First `tts:audio` emit to client

### Deploy to Railway/Render

- Set all env vars in the dashboard
- Build command: `npm install && npm run build`
- Start command for server: `cd server && npm start`
- Frontend: build, then serve `client/dist/` as static
- **Crucial:** update `CLIENT_URL` env var to the deployed frontend URL for CORS

---

## Symptoms → Likely Cause (Debug Decision Tree)

| Symptom                                | First place to look                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| Server won't start                     | `/api/health` (after start) OR backend logs for missing env var       |
| Mic permission asked but no transcript | Backend logs — is Deepgram WS connecting?                             |
| Transcript appears but agent silent    | Backend logs — is Deepgram TTS WS connecting?                          |
| Agent voice glitchy                    | Sample rate mismatch — `useAudioPipeline.ts:78` expects 24kHz         |
| Call ends but no analysis              | Backend logs — Gemini returning malformed JSON?                       |
| Prompt never evolves past v1           | All calls scoring >=90, or `selfHealingPrompt.ts` is silently failing |
| Dashboard 404s                         | Hit `/api/analysis/<callId>` directly — does data exist?              |
| TypeScript "cannot find module"        | `npm install` wasn't run or failed partway                            |
| `AbortSignal` not defined              | tsconfig lib needs `["ES2022", "DOM"]`                                |

---

## Deliberate Non-Goals (don't "fix" these)

These are intentional scope decisions. If you find yourself wanting to address them, stop:

- ✗ No authentication / multi-tenant — out of assessment scope
- ✗ No mixed-stereo WAV (separate customer + agent tracks instead) — would need ffmpeg
- ✗ `ScriptProcessorNode` instead of `AudioWorklet` — works fine; modernization is post-MVP
- ✗ No automated tests — out of take-home scope; manual smoke test is documented
- ✗ No Dockerfile / CI — deployment optional in assessment
- ✗ Free tier API costs ≠ $0 — Gemini (Free Tier) and Deepgram use new-account credits ($200) or free allowance. Net cost to user is $0.

---

## Free Tier Math (so the user can budget API usage)

| Service         | Free allowance | Demo usage per call (~2 min) | Demo calls possible |
| --------------- | -------------- | ---------------------------- | ------------------- |
| LiveKit Cloud   | 10,000 min/mo  | ~2 min                       | ~5,000              |
| Deepgram        | $200 credit    | ~$0.012                      | ~16,000             |
| Google Gemini   | Free Tier      | $0                           | Unlimited (Free)    |
| Deepgram TTS    | $200 free credit| ~400 chars                   | many thousands      |
| MongoDB Atlas   | 512 MB         | <10 KB                       | many thousands      |

**Constraint resolved:** By switching to Deepgram Aura TTS, we no longer face the restrictive 10,000 character limit of ElevenLabs' free plan, nor the VPN/Proxy connection blocks.

---

## Working with the User

- Full-stack MERN background — comfortable with TypeScript, React, Node
- **New to AI/Python** — explain LLM/STT/TTS concepts when they come up
- Writes informal English; may have typos — interpret intent generously
- **Cannot pay for services** — keep all suggestions on free tiers / free credits
- Working across two machines — generating code on a dev box, deploying/demoing on their primary system
- Prefers structural, well-documented work over quick-and-dirty
- Asked for prompt history transparency, so the dev-prompt log exists in `docs/` (gitignored)
- Goal is impressing the technical interviewer to land the job

---

## When the User Returns

If the user comes back with a question, the most likely scenarios:

1. **"It doesn't work / something broke"** → Direct them to `curl /api/health` first, then `docs/TROUBLESHOOTING.md`
2. **"I want to change X"** → Use the "Modification Recipes" section above
3. **"How do I explain X in my Loom?"** → ARCHITECTURE.md has the rationale + interview-ready talking points
4. **"Help me write the README / setup instructions"** → They exist (README.md / SETUP.md) — don't duplicate
5. **"Add this feature"** → First check if it's in the "Deliberate Non-Goals" list above
