# Server — Backend Context

> Read the root [`CLAUDE.md`](../CLAUDE.md) first for full project context.

## Stack
Node.js 18+ · TypeScript (target ES2022) · Express · Socket.IO · MongoDB/Mongoose

## Key Files and What They Do

| File | Purpose |
|---|---|
| `src/index.ts` | Express + Socket.IO server entry; wires events to AgentPipeline |
| `src/config/index.ts` | Loads `.env` from project root (`../../../.env`); single source of truth |
| `src/services/agent/agentPipeline.ts` | ⭐ Core STT→LLM→TTS loop; latency-critical |
| `src/services/stt/deepgramService.ts` | Deepgram WebSocket streaming STT |
| `src/services/llm/geminiService.ts` | Gemini streaming generator + one-shot analysis |
| `src/services/tts/deepgramTtsService.ts` | Deepgram WebSocket streaming TTS |
| `src/services/recorder/callRecorder.ts` | Buffers PCM audio, writes WAV files |
| `src/services/analysis/callAnalysis.ts` | Post-call Gemini QA analysis |
| `src/services/analysis/analysisPrompts.ts` | Prompt template builders (analysis + meta-prompt) |
| `src/services/promptEvolution/selfHealingPrompt.ts` | ⭐ Seeds v1; generates + applies patches |
| `src/services/livekit/roomService.ts` | Async `toJwt()` for v2 SDK |
| `src/database/models/*` | Mongoose schemas (Call, Transcript, Analysis, PromptVersion) |
| `src/routes/health.ts` | `/api/health` — validates every env var + Mongo |
| `src/routes/calls.ts` | `POST /api/calls/start` — issues callId, room, token, prompt version |
| `src/routes/analysis.ts` | `GET /api/analysis/:callId` — scorecard + transcript |
| `src/routes/prompts.ts` | `GET /api/prompts` — version history |
| `src/utils/audioUtils.ts` | WAV writer; `formatTimestamp` ([HH:MM:SS]) |

## Socket.IO Event Protocol

### Client → Server
| Event | Payload | When |
|---|---|---|
| `call:start` | `{callId}` | After REST `POST /api/calls/start` succeeds |
| `audio:chunk` | `ArrayBuffer` | 16kHz mono Int16 PCM chunks (~128ms each) |
| `call:end` | (none) | User clicks End Call |

### Server → Client
| Event | Payload | Meaning |
|---|---|---|
| `call:started` | `{callId, promptVersion}` | Agent pipeline ready |
| `transcript:interim` | `{text, speaker}` | Live STT (not finalized) |
| `transcript:final` | `{text, timestamp, speaker}` | Committed customer turn |
| `agent:thinking` | (none) | Gemini API call in progress |
| `agent:speaking` | (none) | TTS stream starting |
| `agent:response` | `{text, timestamp}` | Full agent turn text (after streaming completes) |
| `tts:audio` | `Buffer` | 24kHz mono Int16 PCM chunk |
| `tts:done` | (none) | TTS stream complete for this turn |
| `tts:interrupted` | (none) | Mid-TTS interruption — clear playback queue |
| `dead_air_detected` | `{timestamp, durationMs}` | >3s of silence ended |
| `call:ended` | `{callId, duration}` | Recording saved |
| `analysis:started` | (none) | Background analysis running |
| `analysis:complete` | `{callId, scorecard}` | Full JSON scorecard |
| `prompt:evolved` | `{version, summary}` | New prompt version created (only if score < 90) |

## Latency Notes — Target <1.5s

| Stage | Time | Optimization |
|---|---|---|
| Deepgram endpointing | 300ms | Configured via `endpointing=300` |
| Gemini first token | ~350ms | Gemini-2.5-flash; short max_tokens (400) |
| First sentence buffer | ~200ms | `extractSentences` splits on `[.!?]\s+` |
| Deepgram first audio | ~150ms | Aura model |
| Network + decode | ~100ms | Direct PCM, no codec |
| **Total** | **~1250ms** | Beat the 1500ms target |

## Self-Healing Trigger

Fires after every call if `rubric_score < 90`. Flow:
1. `runCallAnalysis()` writes scorecard to DB
2. `generateAndApplyPatch()` reads current prompt + failures, calls meta-prompt
3. Applies patches via section-targeted regex
4. Saves new `PromptVersion` row
5. Next call's `getCurrentPrompt()` returns the new version automatically

## Environment Variables

See root `.env.example`. Server reads from `../../../.env` relative to `src/config/index.ts`. All required vars are validated by `/api/health`.

## TypeScript Quirks

- `tsconfig.json` uses `lib: ["ES2022", "DOM"]` — required for global `AbortSignal`/`AbortController` typing
- `strict: true` is on — every implicit-any is an error
- Mongoose model definitions: do NOT redefine if `mongoose.models.X` exists (would throw on hot reload, but nodemon respawns the process so practically not an issue)

## Common Gotchas

- Deepgram TTS WS returns raw binary audio buffer directly — forward to client as is
- Deepgram requires `Authorization: Token <KEY>` header (not `Bearer`)
- `livekit-server-sdk` v2: `toJwt()` is async — must await
- Audio chunks from browser are `ArrayBuffer` in Socket.IO; convert to `Buffer` server-side
- The `interruptTTS()` path closes the Deepgram TTS WS — a new connection is made for the next agent response
