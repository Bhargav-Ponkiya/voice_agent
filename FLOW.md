# System Flow — NovaTel Voice Agent

This document outlines the problem statement, system architecture, and step-by-step (0-to-1) execution flow of the voice call agent system and its self-healing loop.

---

## 1. Problem Statement
The goal of this system is to build an autonomous, real-time voice call support agent ("Alex") for a fictional telecom provider ("NovaTel") that resolves customer billing complaints (e.g. duplicate charges, late fee waivers, plan cancellations).

The primary challenges are:
1. **Low Latency**: Conversations must feel natural and real-time (perceived response latency must remain under 1.5 seconds).
2. **Graceful Interruption**: The agent must instantly stop speaking the moment the user starts talking over it.
3. **Self-Healing Evolution**: If the agent fails to resolve an issue during a call (scoring below 90/100 on a QA rubric), the backend must automatically analyze the failure, patch the system prompt, and save a new version so the next call performs better.

---

## 2. Technology Stack & Connections

The system is built as a hybrid Node.js/React application:

* **Frontend (React 18 + Vite + Tailwind v4 + Recharts)**: Displays the call interface (waveform, live transcripts, thinking states) and a dashboard showing score trends, sentiment analysis, call stage timelines, and prompt differences.
* **Backend (Node.js + Express + Socket.IO + Mongoose)**: Coordinates streaming pipelines, executes REST endpoints, and manages database interactions.
* **STT (Deepgram Nova-2 streaming WS)**: Listens to incoming customer audio, performs real-time transcription, and detects speech boundaries (endpointing).
* **LLM (Google Gemini Flash)**: Generates conversational responses from system prompts and executes post-call scoring and prompt patching.
* **TTS (Deepgram Aura-2 streaming WS)**: Converts streaming text sentences from Gemini into natural-sounding PCM audio (reusing the same Deepgram API key).
* **Database (MongoDB Atlas)**: Persists calls, transcripts, QA scorecards, and historical prompt versions.
* **Transport (LiveKit + Socket.IO)**: LiveKit manages auth tokens and presence rooms, while Socket.IO handles low-latency raw PCM audio streaming.

---

## 3. The 0-to-1 Execution Flow

Here is the step-by-step process of a voice call, from start to evolution:

### Phase A: Call Initialization
1. **Browser** hits backend REST endpoint `POST /api/calls/start`.
2. **Server** connects to MongoDB, retrieves the latest active system prompt version, generates a unique `callId`, creates a LiveKit room, and generates an access token.
3. **Browser** receives the token and connects to the LiveKit room (for presence) and opens a Socket.IO connection.
4. **Browser** triggers mic capture via `AudioContext` (capturing 16kHz mono Int16 PCM chunks) and sends them to the server via Socket.IO (`audio:chunk`).

### Phase B: Conversational Pipeline (The Live Loop)
5. **Server** receives audio chunks, writes them to a local WAV file buffer, and forwards them directly to **Deepgram STT** via a streaming WebSocket.
6. **Deepgram** transcribes the audio in real-time:
   * While the user is speaking, it emits interim transcripts which the server forwards to the frontend (`transcript:interim`).
   * When the user stops speaking (silence >300ms), Deepgram emits a final transcript.
7. **Server** appends the user's utterance to the conversation history, enters a thinking state (`agent:thinking`), and calls the **Google Gemini API** with the system prompt, history, and an `AbortSignal`.
8. **Gemini** streams response text tokens back to the server:
   * The server buffers incoming text chunks and splits them into complete sentences using punctuation marks (`.!?`).
   * As soon as a complete sentence is parsed, the server sends it directly to the **Deepgram TTS** WebSocket.
9. **Deepgram** converts the sentence into audio chunks (24kHz PCM) and streams them back.
10. **Server** receives the audio chunks and sends them to the browser via Socket.IO (`tts:audio`).
11. **Browser** decodes the chunks and plays them in sequence using the Web Audio API.

#### Handling Interruption:
* If the user speaks while the agent is playing audio:
  * Deepgram detects speech and emits a `SpeechStarted` event.
  * Server catches this and immediately triggers `AbortController.abort()` on the Gemini request, closes the Deepgram TTS connection, and tells the browser to clear its audio queue (`tts:interrupted`). The agent falls silent instantly.

### Phase C: Call Finalization & Self-Healing Loop
12. **User** clicks "End Call".
13. **Server** stops active audio capturing, closes all WebSockets, saves the final WAV audio recording, and creates a completed call document in MongoDB.
14. **Post-Call Analysis (Background Process)**:
    * Server sends the complete transcript, call duration, and dead-air logs to Gemini with a **QA Rubric Prompt**.
    * Gemini evaluates the call and returns a structured JSON scorecard containing:
      - A final QA score (1–100).
      - Section-by-section rubric passes/fails.
      - A list of specific `failure_moments` (with typed classifications like "verification_failed").
    * Server saves this analysis to MongoDB.
15. **Prompt Evolution (Self-Healing)**:
    * If the QA score is **below 90**, the server triggers prompt healing.
    * Server sends the current system prompt, the call transcript, and the `failure_moments` to Gemini with a **Meta-Prompt**.
    * Gemini parses the failures and returns a JSON patch detailing target additions or modifications.
    * Server applies the patch to the prompt via section-targeted regex and saves it as a new `PromptVersion` in MongoDB.
    * The next call automatically uses this updated prompt.
