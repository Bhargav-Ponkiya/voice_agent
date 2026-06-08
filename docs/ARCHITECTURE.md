# Architecture — NovaTel Voice Agent

This document explains how every piece of the system fits together. Read this before changing anything in `server/src/services/` or `client/src/hooks/`.

---

## High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          BROWSER (React)                            │
│  ┌──────────────┐   ┌──────────────────────────────────────────┐  │
│  │ Microphone   │──▶│ LiveKitRoom (publishes 16kHz mono track) │  │
│  └──────────────┘   └──────────────────────┬───────────────────┘  │
│  ┌──────────────┐   ┌──────────────────────┴──────────────────┐  │
│  │ Speaker      │◀──│ RoomAudioRenderer (subscribes to agent) │  │
│  └──────────────┘   └─────────────────────────────────────────┘  │
│                                                                   │
│  Socket.IO is used ONLY for control events (transcripts, state,  │
│  scorecard) — never for raw audio.                                │
└─────────────────────────────────────────────────────────────────────┘
                              ↕ LiveKit WebRTC (audio) + Socket.IO (control)
┌─────────────────────────────────────────────────────────────────────┐
│                       SERVER (Node.js + Express)                    │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────┐     │
│   │              AgentPipeline (per call)                    │     │
│   │  ┌───────────┐   ┌────────────┐   ┌─────────────────┐  │     │
│   │  │ Deepgram  │──▶│  Gemini    │──▶│  Deepgram       │  │     │
│   │  │ STT WS    │   │  LLM API   │   │  TTS WS         │  │     │
│   │  └───────────┘   └────────────┘   └─────────────────┘  │     │
│   │       │                │                  │             │     │
│   │       ▼                ▼                  ▼             │     │
│   │  ┌──────────────────────────────────────────────┐      │     │
│   │  │  CallRecorder (PCM buffers → WAV on disk)    │      │     │
│   │  └──────────────────────────────────────────────┘      │     │
│   └─────────────────────────────────────────────────────────┘     │
│                                                                     │
│         After call ends:                                            │
│   │  ┌──────────────┐   ┌───────────────┐   ┌──────────────────┐    │
│   │  │ Analysis     │──▶│ Self-Healing  │   │ PromptVersion DB │    │
│   │  │ (Gemini QA)  │   │ Meta-Prompt   │   │ (Mongo)          │    │
│   │  └──────────────┘   └───────────────┘   └──────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                              ↕
                  ┌──────────────────────┐
                  │  MongoDB Atlas       │
                  │  - calls             │
                  │  - transcripts       │
                  │  - analyses          │
                  │  - prompt_versions   │
                  └──────────────────────┘
```

---

## Audio Pipeline — Why This Design

### The Latency Budget
Assessment requires <1.5s perceived latency. Here's how we hit it:

| Stage | Time | What Happens |
|---|---|---|
| User stops speaking | 0ms | Last audio chunk sent to Deepgram |
| Deepgram endpointing | +300ms | Silence detected, final transcript emitted |
| Network → Gemini | +50ms | Server sends prompt to Google |
| Gemini first token | +350ms | Gemini starts streaming response |
| First complete sentence | +200ms | ~3-5 tokens into first sentence |
| Deepgram first audio | +150ms | First audio chunk back over WS |
| LiveKit WebRTC → browser | +50ms | Subscribed AudioTrack chunk |
| Browser plays chunk | ~0ms | `<RoomAudioRenderer />` |
| **Total perceived latency** | **~1300ms** | User hears agent start speaking |

**Critical optimization:** We don't wait for Gemini to finish. The moment a complete sentence (or `:`/`;`/`\n`) appears in the stream buffer, we send it to Deepgram TTS. The agent starts speaking the first sentence while Gemini is still writing the second.

### Interruption Flow (anti-self-interruption)
Browser echo cancellation isn't perfect; Sarah's own voice occasionally bleeds into the mic and gets transcribed. Naïve barge-in (fire on any interim) caused Sarah to cut herself off mid-sentence. The hardened flow:

1. Deepgram STT emits interim transcripts; server counts them per response.
2. Barge-in fires only when **(a) interim text ≥ 3 chars AND (b) at least 2 interims received this response** — single transient blips from echo are filtered.
3. `interruptTTS()` calls `AbortController.abort()` → Gemini stream stops.
4. Sends `Clear` to Deepgram TTS WS → audio output stops.
5. Clears LiveKit `AudioSource` capture queue → in-flight 10ms frames discarded.
6. Frontend `tts:interrupted` event → UI clears streaming transcript.
7. New customer turn processed normally.

Trade-off: ~100–300ms extra barge-in latency vs. zero self-interruption. Worth it.

---

## Why LiveKit + Socket.IO (Hybrid)

The assessment requires LiveKit for WebRTC audio transport. We use LiveKit for **the audio pipeline itself** via the official `@livekit/rtc-node` SDK:

- **Customer mic** → browser `LiveKitRoom` publishes 16kHz mono track → server `LiveKitTransport.setupAudioStream` subscribes → `agentPipeline.receiveAudio()` → Deepgram STT
- **Agent voice** → Deepgram Aura → `livekitTransport.pushAgentAudio()` publishes via `AudioSource(16000)` → client `<RoomAudioRenderer />` plays it

Socket.IO is used **exclusively for control events**: `call:start`, `transcript:interim`, `transcript:final`, `agent:thinking`, `agent:speaking`, `tts:interrupted`, `dead_air_detected`, `analysis:complete`, `prompt:evolved`. No raw audio crosses the Socket.IO channel.

**Loom talking point:** "LiveKit handles the audio plane end-to-end — both directions go through the LiveKit room. Socket.IO carries only the control plane (transcripts, scorecard, prompt evolution events). This split keeps the audio path WebRTC-native while letting me stream rich structured events to the UI with minimal overhead."

---

## Self-Healing Prompt Loop — Detailed Flow

```
┌──────────┐
│ Call ends│
└────┬─────┘
     │
     ▼
┌────────────────────────────────────────┐
│ 1. runCallAnalysis(callId, turns, ...) │
│    - Builds transcript text             │
│    - Sends to Gemini with analysis      │
│      prompt (see PROMPTS.md)            │
│    - Parses JSON scorecard              │
│    - Saves to `analyses` collection     │
└────────┬────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ 2. generateAndApplyPatch(...)           │
│    - If score >= 90: skip patch         │
│    - Else: read current prompt          │
│    - Send to Gemini with meta-prompt    │
│      (failure_moments + transcript)     │
│    - Parse JSON patch                   │
│    - Apply patches to system prompt     │
│      via section-targeted regex         │
│    - Save as new PromptVersion          │
└────────┬────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ 3. Next call begins                     │
│    - getCurrentPrompt() reads latest   │
│      PromptVersion from DB             │
│    - AgentPipeline initialized with     │
│      the evolved prompt automatically   │
└─────────────────────────────────────────┘
```

### Why this design is robust

1. **Score gate (>= 90)**: Prevents unnecessary churn on already-good prompts
2. **Section-targeted patches**: The meta-prompt forces Gemini to identify which `## Section` to modify; this prevents prompt drift where each iteration undoes the last
3. **Typed failure_moments**: The analysis prompt outputs failures with an enum `type` field — the meta-prompt pattern-matches against this rather than free-form reasoning
4. **Append-only versions**: We never overwrite — every version is stored with the call that triggered it (full audit trail)

---

## Data Model

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   Call       │       │ Transcript   │       │   Analysis   │
├──────────────┤       ├──────────────┤       ├──────────────┤
│ callId  (PK) │◀──1:1─│ callId  (FK) │       │ callId  (FK) │
│ roomName     │       │ turns[]      │       │ rubric_score │
│ startTime    │       │ deadAirSeg[] │       │ sentiment[]  │
│ duration     │       │ fullText     │       │ call_flow[]  │
│ audioFile    │       └──────────────┘       │ failures[]   │
│ promptVer    │                              │ promptVer    │
│ status       │                              └───────┬──────┘
└──────────────┘                                      │
                                                      │ triggers
                                                      ▼
                                              ┌─────────────────┐
                                              │ PromptVersion   │
                                              ├─────────────────┤
                                              │ version  (PK)   │
                                              │ systemPrompt    │
                                              │ triggeredByCall │
                                              │ patches[]       │
                                              │ summary         │
                                              └─────────────────┘
```

---

## Component Responsibility Map

### Backend (`server/src/`)
| File | One-Line Responsibility |
|---|---|
| `index.ts` | Express + Socket.IO entry; wires events to pipeline |
| `config/index.ts` | Reads + validates `.env`; single source of truth |
| `services/agent/agentPipeline.ts` | The brain — orchestrates STT→LLM→TTS per call |
| `services/stt/deepgramService.ts` | Streaming STT WebSocket wrapper |
| `services/llm/geminiService.ts` | Gemini streaming generator + one-shot analysis call |
| `services/tts/deepgramTtsService.ts` | Streaming TTS WebSocket wrapper |
| `services/recorder/callRecorder.ts` | PCM chunk buffer → WAV file writer |
| `services/analysis/callAnalysis.ts` | Post-call Gemini analysis → JSON scorecard |
| `services/analysis/analysisPrompts.ts` | Prompt template builders (analysis + meta) |
| `services/promptEvolution/selfHealingPrompt.ts` | Seed v1, generate patches, apply, save |
| `database/models/*` | Mongoose schemas (Call, Transcript, Analysis, PromptVersion) |
| `routes/*` | REST endpoints — calls, analysis, prompts, health |
| `utils/audioUtils.ts` | WAV file writer + timestamp formatter |

### Frontend (`client/src/`)
| File | One-Line Responsibility |
|---|---|
| `pages/CallPage.tsx` | The call screen (mic + transcript + controls) |
| `pages/DashboardPage.tsx` | QA analysis view (charts + transcript + prompt history) |
| `components/call/VoiceCallInterface.tsx` | Socket.IO wiring + call state machine |
| `components/call/LiveTranscript.tsx` | Real-time transcript bubbles |
| `components/dashboard/QAScorecard.tsx` | Score ring + rubric checks |
| `components/dashboard/SentimentChart.tsx` | Recharts line chart with escalation markers |
| `components/dashboard/CallFlowTimeline.tsx` | Stage bar + per-turn classification |
| `components/dashboard/TranscriptAnnotated.tsx` | Side-by-side transcript + AI annotations |
| `components/dashboard/CallComparison.tsx` | Trend chart across all calls |
| `components/dashboard/PromptVersionHistory.tsx` | Expandable version cards with diff |
| `hooks/useAudioPipeline.ts` | Mic capture + TTS playback (Web Audio API) |
| `services/api.ts` | Axios wrapper for REST calls |

---

## Error Handling Strategy

| Failure Mode | What Happens |
|---|---|
| Deepgram WebSocket disconnects | Pending audio buffered; reconnect on next chunk; logged |
| Gemini API timeout | `AbortError` caught; user prompted to repeat |
| Deepgram TTS WebSocket fails to connect | Caught; user gets warning message and call halts gracefully |
| User loses mic permission | Caught at `getUserMedia`; user gets clear error message |
| MongoDB down | Server fails startup with explicit error |
| Malformed JSON from Gemini analysis | `JSON.parse` wrapped in try/catch; analysis fails gracefully |
| Empty transcript (silent call) | Skip analysis with warning log |
| Same call ID submitted twice | Mongoose `upsert: true` makes it idempotent |
| Mic input but socket disconnected | `socket.connected` check before emitting |
| Interruption mid-TTS | AbortController + WebSocket close + audio queue clear |

---

## Free-Tier Cost Profile

A 3-call demo (2 min average) uses:

| Service | Usage | Cost |
|---|---|---|
| Deepgram Nova-2 | ~6 min STT @ $0.0058/min | $0.035 (from $200 credit) |
| Gemini 2.5 Flash (live agent) | ~6 turns × 200 tokens | $0 (Free Tier) |
| Gemini 2.5 Flash (analysis + meta) | 3 calls × ~3000 tokens | $0 (Free Tier) |
| Deepgram Aura | ~1200 chars TTS | from $200 free credit |
| LiveKit Cloud | ~6 minutes | from 10k/mo free |
| MongoDB Atlas | ~10MB | well under 512MB free |

**Total cost per demo: ~$0.06** (paid from free signup credits)

---

## What's NOT Built (intentional scope limits)

- LiveKit Egress for server-side recording (we record from Socket.IO chunks instead)
- AudioWorklet (we use deprecated ScriptProcessor for simplicity)
- Real-time sentiment streaming (sentiment only analyzed post-call)
- Multi-user calls (one customer per call)
- Authentication (no users/login — anyone can call)
- Production deploy config (no Dockerfile, no CI)

These are documented as known limitations in [README.md](./README.md).
