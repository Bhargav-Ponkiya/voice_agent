# Client — Frontend Context

> Read the root [`CLAUDE.md`](../CLAUDE.md) first for full project context.

## Stack
React 18 · TypeScript · Vite 5 · **Tailwind v4 (CSS-first)** · Recharts · Socket.IO client · axios · lucide-react

## Pages

| Route | Component | Purpose |
|---|---|---|
| `/` | `CallPage` | Mic + transcript + Start/End call controls |
| `/dashboard` | `DashboardPage` | Latest call analysis (defaults to most recent) |
| `/dashboard/:callId` | `DashboardPage` | Specific call analysis |

## Component Map

| Component | Purpose |
|---|---|
| `VoiceCallInterface` | Socket.IO wiring + state machine + mic + TTS playback orchestration |
| `LiveTranscript` | Real-time message bubbles with interim/final distinction |
| `QAScorecard` | Animated score ring + rubric pass/fail items + agent signals + flags |
| `SentimentChart` | Recharts AreaChart with custom escalation-marker dots |
| `CallFlowTimeline` | Proportional stage bar + per-turn classification list |
| `TranscriptAnnotated` | Side-by-side transcript with stage/sentiment/failure annotations |
| `CallComparison` | Bar chart of scores across calls + delta + avg signals |
| `PromptVersionHistory` | Expandable version cards with patches + diff vs prior version |

## Key Hooks

| Hook | Purpose |
|---|---|
| `useAudioPipeline` | Mic capture (16kHz ScriptProcessor) + TTS playback (24kHz Web Audio API) |
| `useSocket` | Generic Socket.IO connection wrapper (currently unused — `VoiceCallInterface` instantiates its own) |

## Audio Architecture

```
[Browser mic]
     ↓
getUserMedia({audio: true, sampleRate: 16000})
     ↓
AudioContext(16000) + ScriptProcessor(2048)
     ↓
Float32 → Int16 conversion per chunk
     ↓
Socket.IO emit("audio:chunk", ArrayBuffer)
     ↓
[Server]
     ↓
Socket.IO event "tts:audio" with Buffer
     ↓
Int16 buffer → Float32Array (i / 32768.0)
     ↓
AudioContext(24000).createBuffer + queue
     ↓
[Speaker]
```

**Why two AudioContexts (one for input, one for output):** Different sample rates (16k input from Deepgram constraint; 24k output from Deepgram TTS format). Web Audio API contexts have one fixed sample rate each.

## Styling — Tailwind v4

**No `tailwind.config.js`!** Tokens are in `src/index.css`:

```css
@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.62 0.23 280);   /* indigo-violet — AI product feel */
  --font-sans: "Inter", ...;
  --radius-2xl: 20px;
}
```

Tailwind generates utilities from `@theme` automatically: `bg-brand-500`, `text-brand-300`, etc.

**Custom utilities:** `.glass`, `.glass-strong`, `.glow-brand`, `.text-gradient`, `.btn-shine`, `.fade-up`, `.soft-pulse`, `.waveform-bar`, `.float-particle`.

**Color philosophy:** Dark background with radial gradient; cards use glassmorphism (backdrop-blur + low opacity); brand color is sophisticated indigo/violet for "AI product" feel.

## API Calls

All REST goes through `src/services/api.ts` via axios. Vite dev proxy routes `/api/*` and `/socket.io/*` to `http://localhost:3001`.

Endpoints used:
- `POST /api/calls/start` → returns callId + LiveKit token + prompt version
- `GET /api/calls` → list completed calls
- `GET /api/analysis` → list all analyses
- `GET /api/analysis/:callId` → single scorecard
- `GET /api/analysis/:callId/transcript` → turns + dead air segments
- `GET /api/prompts` → all PromptVersion docs (for history panel)

## State Management

No global store. State lives in:
- `VoiceCallInterface` — call lifecycle (refs for socket + timer; useState for status, turns, duration)
- `DashboardPage` — fetched analyses + transcript + prompt versions

## Performance Notes

- The mic capture uses deprecated `ScriptProcessorNode` (runs on main thread). For production: replace with `AudioWorklet` (runs in audio thread).
- Sentiment chart uses Recharts `<AreaChart>` with custom dot renderers — heavy with hundreds of turns, fine at typical call lengths
- The "diff" in `PromptVersionHistory` is line-by-line set difference — won't show modified lines as modifications, just as adds+removes

## Common Gotchas

- TTS playback queue is FIFO; if the audio is glitchy, check `useAudioPipeline.ts:78` — must use 24000 Hz when constructing `AudioBuffer`
- `socketRef.current` may be `null` during initial render; always null-check
- React's `useEffect` dependencies for the audio pipeline are intentionally minimal — adding too many will recreate the pipeline mid-call
- The `stopTTS()` recreates the entire output AudioContext — this is intentional to instantly stop queued audio for interruption
