# Problems & Solutions — NovaTel Refactoring Reference

This document serves as a developer reference detailing the core architectural issues, edge cases, and performance bottlenecks identified in the voice agent project and how they were resolved.

---

## 1. LLM Provider Migration (Claude to Gemini)
### Problem
* Free Anthropic Claude API keys are extremely difficult to obtain.
* The Anthropic Node SDK adds additional dependencies and can occasionally run into native code compilation checks during target cloud builds (e.g., Railway/Vercel).

### Solution
* **Refactoring:** Replaced all Claude references with Google Gemini (`gemini-2.5-flash`).
* **Implementation:** Wrote a lightweight, custom integration in `server/src/services/llm/geminiService.ts` using Node 18's native global `fetch`. This uses Gemini's SSE (Server-Sent Events) endpoint directly for live streaming and standard POST requests for QA analysis, removing any dependency on third-party LLM SDKs.

---

## 2. Empty Widescreen Layout & Centering
### Problem
* On desktop monitors, the Call Page used a single-column layout stretched to `max-w-7xl` (1280px). This resulted in large, empty margins and forced text to stretch excessively, making the visualizer and transcript awkward to read.

### Solution
* **Refactoring:** Re-architected `client/src/components/call/VoiceCallInterface.tsx` to use a responsive desktop grid layout (`lg:grid-cols-12 gap-6 items-stretch`).
  * **Left Side (`lg:col-span-5`):** Grouped the status pill, visualizer orb card (using `flex-1` to stretch and balance height), and calling controls.
  * **Right Side (`lg:col-span-7`):** Placed the scrollable conversation transcript.
  * **Mobile:** Stacks vertically automatically.

---

## 3. Theme & Color Inconsistencies
### Problem
* The application header was styled with a light backdrop (`bg-white/60`) while the body background was styled with metallic obsidian dark hues.
* Chat transcript bubbles in `LiveTranscript.tsx` and annotated lists assumed a light background, making text invisible or low contrast.

### Solution
* **Refactoring:** Converted the entire neutral design system in `client/src/index.css` to a **Premium Light Console** theme.
  * Remapped `--color-surface-*` variables to slate-gray hues (`#f8fafc` background, pure white cards, slate-200 borders).
  * Styled `.glass` cards into clean white panels with light borders and subtle drop shadows.
  * Updated Recharts tooltips, timeline indicators, scrollbars, and badges to match the light layout.

---

## 4. Stuck Active Calls on Unexpected Client Disconnects
### Problem
* If a user closed the browser tab, refreshed the page, or lost internet mid-call, the server's `disconnect` handler stopped the audio pipeline but left the call document status as `'active'` in MongoDB.
* Orphaned call documents were never analyzed, never appeared in the dashboard history dropdown, and did not trigger the self-healing evolution loop.

### Solution
* **Refactoring:** Extracted call end logic into a shared, reusable function `handleCallTermination` in `server/src/index.ts`.
* **Behavior:** It calculates elapsed call duration, updates the MongoDB record to `'completed'`, deletes the LiveKit room, and runs the post-call analysis asynchronously even if the socket connection is already dead.

---

## 5. Resilient JSON Extraction from LLM Responses
### Problem
* LLMs (specifically Google Gemini) sometimes wrap JSON output in markdown blocks (````json ... ````) or prepend introductory sentences (e.g., *"Here is the scorecard..."*).
* A simple `JSON.parse` on the raw LLM response crashed the analysis script and blocked prompt evolution.

### Solution
* **Refactoring:** Implemented a robust `extractJson` utility function in both `callAnalysis.ts` and `selfHealingPrompt.ts`.
* **Behavior:** It attempts a standard `JSON.parse` first. If that fails, it uses search indexes to locate the string block starting at the first `{` and ending at the last `}`. This strips any outer text, protecting the parser from LLM formatting anomalies.

---

## 6. Production Domain Socket.IO Routing
### Problem
* The client's `VoiceCallInterface.tsx` initialized Socket.IO connections via a hardcoded relative path `io('/')`.
* If the React frontend and Node backend are hosted on separate domains in production (e.g., frontend on Vercel and API on Railway), the websocket request would fail because it tries to connect to the frontend server.

### Solution
* **Refactoring:** Configured Socket.IO client in `VoiceCallInterface.tsx` to respect `import.meta.env.VITE_API_URL || '/'`, aligning it with Vite configuration standards.

---

## 7. No Rate Limiting — DoS and API Cost Risk
### Problem
* Any actor (malicious or accidental) could spam `POST /api/calls/start`, creating unlimited voice sessions. Each call consumes real API quota from Deepgram, ElevenLabs, and Gemini.
* REST routes and Socket.IO connections had no per-IP throttle.

### Solution
* Added `express-rate-limit` middleware to all REST routes (**120 req/min** general limit).
* Added a stricter **10 req/min** rate limiter specifically on `POST /api/calls/start` to protect per-call API spend.
* Added a socket IP connection tracker in `server/src/index.ts` — each IP is capped at **5 concurrent socket connections**. Excess connections receive a `call:error` event and are disconnected.

---

## 8. MongoDB Connection — No Reconnect Logic
### Problem
* `mongoose.connect()` was called without pool or timeout options. If MongoDB experienced a transient network hiccup, the driver silently failed without retrying. The server would continue running but all DB operations would throw unhandled errors.

### Solution
* Added `maxPoolSize: 10` / `minPoolSize: 2` to `mongoose.connect()` options for controlled connection pooling.
* Added `serverSelectionTimeoutMS` and `socketTimeoutMS` to prevent infinite waits.
* Registered `disconnected`, `reconnected`, and `error` event listeners on `mongoose.connection` for observability and auto-reconnect notification.

---

## 9. Unbounded In-Memory Audio Buffer (Memory Leak)
### Problem
* `DeepgramSTT.pendingAudio` accumulated incoming `Buffer` chunks if the WebSocket connection to Deepgram stalled. With no cap, this array grew unbounded — for a 10-minute call with no STT connection, this could consume hundreds of MB of server RAM.
* `CallRecorder` stored the entire call's PCM audio as two separate `Buffer[]` arrays in RAM simultaneously — one per audio track.

### Solution
* **Deepgram:** Added `MAX_PENDING_CHUNKS = 50` cap. When full, oldest chunks are dropped (ring buffer behavior). Pre-connection audio is inherently too stale to be useful anyway.
* **CallRecorder:** Replaced in-memory `Buffer[]` accumulation with streaming writes to temp `.pcm` files on disk. Audio is written to disk as it arrives. At call end, `finalize()` reads each temp file once, writes it to a WAV container, then deletes the temp file.

---

## 10. Prompt Version Race Condition (Concurrent Calls)
### Problem
* `generateAndApplyPatch` read the current prompt version and created `nextVersion = current.version + 1`. If two calls finished simultaneously and both saw `version = 3`, both would attempt to write a new `version = 4` document, causing a MongoDB duplicate key error.

### Solution
* Added a module-level `patchInProgress` boolean mutex. Only one self-healing patch can execute at a time. Concurrent callers that fail the mutex check skip patching and log a warning. The mutex is released in a `finally` block to prevent permanent lock-out after errors.

---

## 11. Gemini `analyzeCall` — No Timeout
### Problem
* The `analyzeCall` function in `geminiService.ts` made a raw `fetch()` with no timeout. A slow or hung Gemini response would block the entire post-call analysis pipeline indefinitely — preventing the call from being marked complete in the DB, the LiveKit room from being deleted, and the prompt from evolving.

### Solution
* Added an `AbortController` with a **30-second timeout** to `analyzeCall`. If Gemini does not respond within 30 seconds, the fetch is aborted and an informative error is thrown, allowing the analysis pipeline to fail gracefully rather than hang.

---

## 12. Client: Stale Closure in Socket Disconnect Handler
### Problem
* The `socket.on('disconnect', ...)` handler in `VoiceCallInterface.tsx` closed over the `status` variable from when it was registered (typically `'connecting'`). The closure value never updated, so the `if (status === 'active' ...)` guard always evaluated to `false`, meaning unexpected disconnects were silently swallowed.

### Solution
* Rewrote the handler to check the disconnect `reason` string instead of the stale `status` value. Only `'io client disconnect'` (user-initiated) is treated as benign. All other reasons show an appropriate error message and set the UI to an error state.

---

## 13. Client: `analysis:complete` Could Hang UI Forever
### Problem
* If the server crashed or threw an unhandled exception after emitting `analysis:started`, the client would remain in the `'analyzing'` state indefinitely with no escape.

### Solution
* Added a **60-second analysis timeout** in the client. When `analysis:started` fires, a `setTimeout` is armed. If `analysis:complete` doesn't arrive within 60 seconds, the UI transitions to an error state with a message directing the user to the dashboard.
* Also added a handler for the `analysis:error` socket event (previously unhandled on the client).

---

## 14. No Input Sanitization on Route Params
### Problem
* REST routes like `GET /api/calls/:callId` and `GET /api/analysis/:callId` passed the raw param string directly to MongoDB `findOne({ callId: req.params.callId })`. A crafted path could attempt operator injection (e.g., `{ "$gt": "" }`).

### Solution
* Added a UUID format regex (`/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i`) validation on all `callId` path parameters. Non-UUID values immediately receive a `400 Bad Request` response before hitting the database.

---

## 15. Missing DB Indexes for Dashboard Queries
### Problem
* `Call.find({ status: 'completed' }).sort({ startTime: -1 })` and `Analysis.find().sort({ createdAt: -1 })` both performed full COLLSCAN operations. As the database grows, these queries degrade linearly.

### Solution
* Added `CallSchema.index({ status: 1, startTime: -1 })` — the exact compound index for the dashboard calls list.
* Added `AnalysisSchema.index({ createdAt: -1 })` — the sort index for the analysis history endpoint.

---

## 16. Large Frontend Bundle (No Code Splitting)
### Problem
* The Vite production build produced a single 691KB (203KB gzipped) JavaScript chunk. Every page load fetched the entire application, including rarely-used dependencies. Browser caching was also ineffective — any code change invalidated the entire bundle.

### Solution
* Added `rollupOptions.output.manualChunks` in `vite.config.ts`:
  * `vendor-react` — React + ReactDOM (rarely changes)
  * `vendor-router` — React Router
  * `vendor-socket` — Socket.IO client
  * `vendor-icons` — Lucide React
  * `vendor-charts` — Recharts
* Vendor chunks are long-cached by the browser. Only the app chunk is refetched on deploys.

---

## 17. TTS Provider Migration (ElevenLabs to Deepgram Aura 2)
### Problem
* ElevenLabs Free Tier accounts frequently trigger `detected_unusual_activity` flags and get suspended or blocked due to automated bot check mechanisms or access via varying developer IPs/VPNs.
* Account creation demands credit card verification or leads to swift suspension, making it unsustainable for a free-tier developer voice agent project.

### Solution
* **Refactoring:** Fully migrated the Text-to-Speech (TTS) pipeline to Deepgram Aura-2.
* **Implementation:**
  * Wrote a streaming WebSocket integration in `server/src/services/tts/deepgramTtsService.ts` pointing to `wss://api.deepgram.com/v1/speak?model=aura-2-asteria-en&encoding=linear16&sample_rate=24000`.
  * The TTS service reuses the existing `DEEPGRAM_API_KEY` created for Speech-to-Text (STT), removing the need for additional environment variables or API key credentials.
  * Unlike ElevenLabs, Deepgram Speak WebSocket accepts text and streams raw linear16 PCM binary buffers directly over the socket, bypassing base64 decoding overhead on the client side, which further minimizes latency.

---

## 18. [CRITICAL] Agent Stuck After First User Turn — STT `speech_started` Race Condition

### Problem
After the agent delivered its greeting and the user spoke their first sentence, the agent would never respond again. The pipeline appeared healthy (no errors, no crashes, no timeouts) — it simply went silent. The server logs showed the exact failure sequence:

```
[INFO]  STT Final transcript: "My bill this month is wrong. I was charged twice."
[INFO]  streamAgentResponse called. userText: "...", speakId: 2
[INFO]  Requesting Gemini stream...
[INFO]  GeminiService streamResponse attempting call using model: gemini-2.5-flash
[INFO]  GeminiService Client abort event received      ← 700ms AFTER starting!
[INFO]  tts.clear() called
[INFO]  Sent Clear message to Deepgram
 ← DEAD SILENCE. No next turn ever starts.
```

**Root Cause — Three-Phase Race Condition:**

1. Deepgram STT fires `speech_started` once when it detects the *beginning* of an utterance.
2. After the utterance ends, Deepgram fires `transcript:final`. This calls `handleCustomerInput()`, which starts `streamAgentResponse()`. Inside, a **fresh** `AbortController` is created and `isSpeaking = true` is set.
3. Deepgram then fires a **second `speech_started`** event — this is a known artifact of Deepgram's end-of-utterance boundary detection logic (VAD events sometimes fire late on utterance boundaries). At this point: `isSpeaking = true` AND `!isGreetingInProgress` → `interruptTTS()` fires → **the brand-new `AbortController` is aborted** while the Gemini request is already in flight.
4. The Gemini `fetch()` receives the abort signal → throws `AbortError`. The `catch` block in `streamAgentResponse` silently swallows `AbortError` (by design, to allow clean user-interrupts). The function returns. No error is emitted to the client, no next turn is scheduled. **The pipeline freezes.**

This is an extremely subtle bug because:
- It looks identical to a user legitimately interrupting the agent.
- The silence is total — no logs, no errors, no timeouts.
- It only happens on the first real customer turn (after greeting), not during the greeting itself (which is protected by `isGreetingInProgress`).
- The timing is fragile: it depends on Deepgram's VAD event delivery order, which varies by ~100-800ms.

### Solution
Three-layer fix in `server/src/services/agent/agentPipeline.ts`:

**Layer 1 — Cooldown Guard on `speech_started`:**
Added a `lastInterruptMs` timestamp that is updated every time `interruptTTS()` is called. The `speech_started` handler now checks `Date.now() - this.lastInterruptMs > 600ms` before triggering another interrupt. This prevents the second, artifact `speech_started` from killing a turn that just started.

**Layer 2 — `setImmediate` Yield Before Gemini Fetch:**
Added a single `await new Promise<void>(r => setImmediate(r))` at the start of `streamAgentResponse`, immediately after creating the `AbortController`. This yields control back to the event loop for one tick, allowing any synchronous event callbacks (like a late `speech_started`) to complete. The code then checks `abortSignal.aborted` before touching the network — if already aborted, it logs a warning and returns cleanly without consuming API quota.

**Layer 3 — Stamped `lastInterruptMs` in `interruptTTS()`:**
`interruptTTS()` itself now stamps `this.lastInterruptMs = Date.now()`, ensuring the cooldown counter is accurate regardless of whether the interrupt came from `speech_started` or from `handleCustomerInput`.

**Key Lesson:** In real-time audio pipelines, **STT VAD events are inherently non-deterministic in their ordering relative to transcript events**. Never assume that `transcript:final` is the last event you'll receive for a given utterance. Always add cooldown guards to interrupt handlers.

---

## 19. Gemini `streamResponse` — Premature 5-Second Connection Timeout

### Problem
Intermittent failures where the agent would not respond to the user after a valid transcript, showing this in logs:
```
[WARN]  GeminiService Connection timeout (5s) exceeded for model: gemini-2.5-flash
[ERROR] GeminiService Model gemini-2.5-flash failed or timed out:
        AbortError: This operation was aborted
```
The 5-second connection timeout was too aggressive for real-world conditions. Gemini API has variable latency depending on:
- Model warm-up (cold start) can take 3–8 seconds
- Network round-trip time from local dev machine to Google data centers
- Peak demand periods (especially during free-tier throttling)
- The `gemini-2.5-flash` model using internal chain-of-thought reasoning can take extra seconds before streaming the first token

A 5-second timeout is not enough headroom for these real-world variables. The agent silently gave up just before Gemini was about to respond.

### Solution
- Increased the **connection timeout** (time to receive HTTP headers from Gemini) from 5 seconds to **15 seconds**.
- Increased the **stream read inactivity timeout** (maximum gap between consecutive SSE chunks) from 5 seconds to **15 seconds**.
- The stream timeout still resets on every received chunk, so long responses are not affected — only long *gaps* between tokens would trigger it.


**Key Lesson:** When setting API timeouts for LLM streaming endpoints, always test under realistic free-tier load, not just best-case latency. A conservative 15–20 second connection timeout is appropriate for paid API calls; for free-tier or unpredictable traffic, 30 seconds may be needed.

---

## 20. [INDUSTRY PATTERN] Barge-In With Context Loss — Fragmented Utterance Accumulation

### Problem
From `pipeline.log` (lines 377–389), a clear context-loss pattern was observed:
```
[INFO] STT Final transcript: "Basically, like, I was charged"     ← Fragment 1
[INFO] streamAgentResponse called. userText: "Basically, like..."  ← Gemini starts too early
[INFO] GeminiService Client abort event received                    ← Second fragment interrupts
[INFO] STT Final transcript: "two time in one month."              ← Fragment 2
[INFO] streamAgentResponse called. userText: "two time in one..."  ← Only fragment 2 sent
```

**What happened:** Deepgram's endpointing (`endpointing=300ms`) is designed to detect natural pauses and fires `transcript:final` on every short pause — even in the middle of a sentence. When the user paused after "I was charged", Deepgram fired a final. The pipeline immediately started a Gemini request with just that partial phrase. When the second fragment "two time in one month" arrived ~500ms later, it triggered `handleCustomerInput` again, aborting the first and starting a new request with **only the second fragment**. Gemini received an incomplete and disjointed input; the first fragment was permanently lost from both conversation history and from the Gemini prompt.

This is a fundamental limitation of naive transcript handling in real-time voice agents. The correct industry-standard pattern is **barge-in with accumulation**.

### Solution — Utterance Accumulation Buffer (1200ms Debounce)

Added three new fields to `AgentPipeline`:
- `utteranceBuffer: string` — accumulates all final transcript fragments
- `utteranceDebounceTimer: NodeJS.Timeout | null` — the silence detection timer
- `UTTERANCE_DEBOUNCE_MS = 1200` — 4x the Deepgram endpointing delay (300ms × 4)

**New behavior:**
1. Every `transcript:final` appends its text to `utteranceBuffer` and restarts the debounce timer
2. The `transcript:final` socket event is emitted with the **accumulated text** (not just the fragment) so the client transcript panel always shows the growing full utterance
3. The debounce timer fires after 1200ms of silence → flushes the buffer → sends the complete utterance to Gemini
4. `speech_started` cancels the debounce timer (a new utterance is forming, old buffer stays pending)
5. If the agent is speaking when a new fragment arrives, `interruptTTS()` is called immediately — but the utterance accumulation continues independently

**Frontend fix:** The `transcript:final` handler in `VoiceCallInterface.tsx` was updated to *replace* the last Customer turn (rather than always adding new turns), since the server now sends the same turn incrementally as it builds up.

**Key Lesson:** In real-time voice agents, **never call your LLM on every `transcript:final` event**. Always buffer with a 1–2 second silence window. The industry-standard for this is sometimes called "hold-and-merge" or "utterance accumulation". Deepgram's built-in `endpointing` setting controls phrase sensitivity (lower = more sensitive = more fragments), but you still need application-layer accumulation for natural speech patterns.

### Tuning Guide
| UTTERANCE_DEBOUNCE_MS | Effect |
|---|---|
| 600ms | Low latency, but may cut off slow speakers mid-sentence |
| **1200ms (current)** | Balanced — handles natural pauses in English speech |
| 2000ms | Handles very slow speakers / heavy accents, but feels sluggish |

---

## 21. Agent Transcript Not Showing in Real-Time — Missing `transcript:agent_stream`

### Problem
The agent transcript panel showed nothing while Alex was speaking. The agent's words only appeared all at once after the full audio clip finished playing. This was because `agent:response` was only emitted **after** `await playbackPromise` resolved — i.e., after Deepgram finished streaming the entire TTS audio.

This creates a poor user experience:
- User hears Alex speaking but sees no text
- Only after the full sentence (3–8 seconds) is spoken does the transcript appear
- There is no way for the user to read along or catch words they may have missed

### Solution — Real-Time Gemini Chunk Streaming to Client

Added a new socket event `transcript:agent_stream` emitted inside the Gemini `for await (const chunk of stream)` loop:

```typescript
// Server — agentPipeline.ts, inside streamAgentResponse()
for await (const chunk of stream) {
  if (abortSignal.aborted) break;
  fullResponse += chunk;
  sentenceBuffer += chunk;

  // NEW: Stream each chunk to the client immediately
  this.socket.emit('transcript:agent_stream', { chunk, speakId });
  // ...
}
```

**Client handling (`VoiceCallInterface.tsx`):**
- Added `streamingAgentText: string` state
- Added `streamingSpeakIdRef` to track the current speakId
- `transcript:agent_stream` handler: appends chunks for the same speakId, resets for a new speakId
- `agent:response` handler: clears `streamingAgentText` and commits the confirmed turn
- `tts:interrupted` handler: clears `streamingAgentText` immediately (partial text disappears on interrupt)
- `agent:thinking` handler: clears `streamingAgentText` (new turn starting)

**`LiveTranscript.tsx` update:**
- Added `streamingAgentText?: string` prop
- Renders a dedicated "Alex — responding…" bubble with a **blinking text cursor** animation
- The bubble is styled with a brand-colored border to distinguish it from committed turns
- Auto-scrolls as new chunks arrive

**Key Lesson:** In streaming LLM voice pipelines, always decouple the TTS playback completion from the transcript display. Text can be shown immediately as the LLM generates it, even though TTS audio delivery has its own queue and delay. Never wait for `playbackPromise` to show the user what the agent is saying.

---

## 22. Debounce Firing Early on Continuous Speech

### Problem
After implementing the 1200ms debounce (Problem 20), a user utterance ("So, yeah, I will provide my account number, but I also want to, like, get my cancel the plan for next month") was still truncated.

The log showed:
```
09:37:58.383  STT Final: "...I also want to, like,"     → debounce starts (1200ms timer)
09:37:58.387  STT Interim: "my cancel"                  → INTERIM arrived
09:37:59.407  STT Interim: "my cancel the plan..."      → INTERIM arrived
09:37:59.599  ⚡ Debounce FIRES! Sends partial text       ← BUG: fired while user still speaking
09:38:00.255  STT Final: "my cancel the plan..."        → too late, debounce already fired
```

**What happened:** The user spoke continuously but with a slight hesitation, triggering a `transcript:final` mid-sentence. Deepgram immediately started sending `transcript:interim` messages for the next phrase ("my cancel..."), meaning the user was clearly still speaking. However, Deepgram *did not* fire a new `speech_started` event because there was no hard silence gap. Because our debounce timer was only cleared on `speech_started`, it blindly ticked down and fired right in the middle of the active interim speech.

### Solution
Reset the utterance debounce timer on **every `transcript:interim`** event as well as `speech_started`.
If we are receiving interim transcripts, the user is by definition speaking, so the silence timer should not be running.

```typescript
// In stt.on('transcript', ...)
if (!data.isFinal) {
  // ...
  // Reset utterance debounce on every interim — it proves user is still speaking.
  if (this.utteranceDebounceTimer) {
    clearTimeout(this.utteranceDebounceTimer);
    this.utteranceDebounceTimer = null;
  }
  return;
}
```

---

## 23. Pipeline Deadlock on Gemini 503 Errors (`isSpeaking` Stuck)

### Problem
A user experienced a 503 Service Unavailable error from Gemini due to high demand.
The system gracefully emitted an `agent:error` to the client... but then the entire call locked up.
The user's subsequent speech was completely ignored.

**What happened:**
When the 503 occurred, `streamResponse` threw an error. The `catch` block caught it, emitted the `agent:error` to the UI, and then re-threw it (`throw err;`).
Because the exception caused the method to exit early, the line `this.isSpeaking = false` (which was sitting at the very bottom of the method) **was never executed**.
The pipeline remained permanently stuck in `isSpeaking = true`. Any new speech from the user was seen as an "interruption" of an agent that wasn't actually speaking, leading to endless loops of `interruptTTS()` without actually processing the user's input.

### Solution
1. **Move State Reset to `finally` Block:** The cleanup of critical state locks (`this.isSpeaking = false`) MUST be in a `finally` block so it is guaranteed to execute whether the stream finishes normally, aborts, or throws an unhandled exception.
2. **Auto-Retry:** Added a `while` loop inside `handleCustomerInput` that intercepts 503 (and 429) transient errors and automatically retries the Gemini request once after a 2.5-second delay, emitting an `agent:retry` event to let the frontend show a "Momentary delay — retrying..." warning instead of failing the turn completely.

---

## 24. LiveKit WebRTC Migration (Removing Socket.io Audio)

### Problem
The initial prototype used raw Socket.io events (`audio:chunk`) to stream raw PCM from the browser microphone to the backend, and (`tts:audio`) to stream TTS PCM back to the browser.
While this worked, it introduced high latency, stuttering, and was inherently unscalable and unsuited for production voice apps which typically require UDP-based WebRTC.

### Solution
* **Refactoring:** Migrated the entire audio transport layer to LiveKit.
* **Backend:** Introduced a `LiveKitTransport` service using `@livekit/rtc-node`. The `AgentPipeline` no longer listens to Socket.io for audio. Instead, it extracts the raw `AudioStream` (PCM) from the LiveKit room to feed Deepgram STT, and pushes Deepgram TTS output (resampled to 16kHz) to a LiveKit `AudioSource`.
* **Frontend:** Removed custom `AudioContext` processing and wrapped the `VoiceCallInterface` inside a `<LiveKitRoom>` and `<RoomAudioRenderer>` using `@livekit/components-react`. The app still uses Socket.io strictly as a low-latency data channel for UI state (transcript syncing, thinking states), perfectly combining WebRTC audio with WebSockets data.

---

## 25. Mixing Asynchronous Audio Streams into a Single Recording

### Problem
The system records both the Customer and the Agent audio to `_tmp_customer.pcm` and `_tmp_agent.pcm`.
However, because they speak asynchronously, simply reading these two raw PCM files and merging them together would result in the agent's voice playing at T=0 of the file, completely out of sync with the real timeline.
We needed a way to merge them into a single WAV file without installing complex external dependencies like `ffmpeg` on the server.

### Solution
* **Zero-Padding Alignment:** Modified `CallRecorder` to track `startTime`. Before writing any new PCM chunk from either side, it calculates the elapsed time. If the bytes written so far are less than what they should be at the current elapsed time (16kHz = 32000 bytes/sec), it fills the gap by writing zero-byte silence buffers.
* **Synchronized Files:** This zero-padding guarantees both temp files perfectly mirror real-time.
* **Manual Mixing:** At call termination, we read the perfectly-aligned buffers and manually average the Int16 sample values: `Math.floor((s1 + s2) / 2)` and clamp them between -32768 and 32767. We then output a single mixed WAV file that represents the exact flow of the conversation.

---

## 26. "Barge-in" Interruption & Synchronized Transcript Handing

### Problem
In voice assistants, users frequently "barge in" or interrupt the agent mid-sentence to correct them or ask a new question. The system must immediately stop speaking, discard the rest of its planned response, and listen.
Additionally, the UI must stay perfectly in sync: the streaming text of the agent's response must stop immediately, avoiding confusing phantom text appearing on screen.

### Solution
* **STT Trigger:** Deepgram STT provides a `speech_started` event. We hooked this up so that the moment the user makes a sound, `AgentPipeline` triggers `interruptTTS()`.
* **Deep Cancellation:** The interrupt method does three things:
  1. Aborts the active Gemini SSE network request (`AbortController`).
  2. Clears the Deepgram TTS WebSocket queue (`tts.clear()`).
  3. Bumps a `speakId` counter.
* **UI Synchronization:** The `speakId` is passed down with every streaming word chunk. If an interruption occurs, the server emits `tts:interrupted`. The frontend checks the `speakId` and immediately dumps any stale streaming text, ensuring the text transcript perfectly matches the abruptly halted audio.
