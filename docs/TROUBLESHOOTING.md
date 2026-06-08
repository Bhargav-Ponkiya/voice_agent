# Troubleshooting

Common issues and how to fix them.

---

## Setup Issues

### `Cannot find module 'livekit-server-sdk'` (or any other module)
**Cause:** `npm install` hasn't been run yet, or it failed partway.
**Fix:** From project root, run `npm install`. Wait for it to finish completely.

### `MongoDB connection failed`
**Common causes:**
- Forgot to replace `<password>` in the connection string with your real password
- Special characters in your password aren't URL-encoded — re-create the DB user with an alphanumeric password
- Your IP isn't allowlisted in MongoDB Atlas → Network Access → Add IP Address → **Allow Access from Anywhere** for development

### `EADDRINUSE: address already in use :::3001`
**Cause:** Another server is already running on port 3001.
**Fix:** Find and kill it: `lsof -i :3001` then `kill -9 <PID>`. Or change the `PORT` in `.env`.

### `EADDRINUSE: address already in use :::5173`
Same as above but for the frontend. Vite will offer to auto-pick a different port; just press `y`.

---

## API Key Issues

### `401 Unauthorized` from Gemini
- Your `GEMINI_API_KEY` is wrong or revoked
- It should start with `AIzaSy`
- Verify on https://aistudio.google.com → API Keys

### `Invalid api key` from Deepgram
- Make sure you copied the full key (not the project ID)
- Test with: `curl -X GET 'https://api.deepgram.com/v1/projects' -H 'Authorization: Token YOUR_KEY'`

### `Quota exceeded` or `Free Tier access disabled` from Deepgram
- Deepgram gives a $200 free credit upon signup which covers millions of characters, but if you hit the limit, you can check usage in your Deepgram console.
- If you face a `"detected_unusual_activity"` or `"unauthorized"` block, it is usually because you are connecting through a VPN or proxy (especially on the Free tier). Try disabling your VPN.

---

## Microphone / Audio Issues

### Browser doesn't ask for mic permission
- You're on `http://` (not `https://`) and the host is *not* `localhost`. `getUserMedia` requires HTTPS *except* on `localhost`.
- Use `http://localhost:5173` exactly (not `127.0.0.1`, not your LAN IP)

### Mic permission denied
- Chrome: `chrome://settings/content/microphone` → make sure `localhost` is allowed
- Firefox: `about:preferences#privacy` → Permissions → Microphone → Settings → remove blocks for localhost
- Try in a private/incognito window

### Agent's voice doesn't play
**Check (in order):**
1. Browser console for Socket.IO errors
2. DevTools → Network → WS — is `tts:audio` event arriving?
3. Backend logs — any Deepgram TTS WebSocket errors?
5. Try a different browser (Safari has Web Audio API quirks)

### Agent speaks but you hear a robotic / glitchy voice
- Probably PCM sample rate mismatch. Deepgram TTS returns 24kHz; our Web Audio context decodes at 24kHz. If you customized this, double-check `useAudioPipeline.ts` (`audioBuffer = ctx.createBuffer(1, ..., 24000)`).

---

## Call Flow Issues

### Call starts but agent never speaks first
- Open backend logs — is Gemini responding?
- Check `agentPipeline.ts` `sendAgentGreeting()` — is it being called?
- Verify `GEMINI_API_KEY` and `GEMINI_MODEL` are set

### STT seems to miss what I'm saying
- Speak more clearly and at normal volume
- Check Deepgram dashboard for any account warnings
- Endpointing is set to 300ms — pauses shorter than that may not finalize a turn

### Agent talks over me
- Should be impossible — STT `SpeechStarted` event calls `interruptTTS()`
- Open browser console — are `tts:interrupted` events firing?
- If not, Deepgram may not be sending VAD events. Add `vad_events: 'true'` is already on by default

### Call ends but no analysis appears
- Open backend logs — does `runCallAnalysis` log success?
- If you see "transcript too short to analyze" — the call had <2 turns. Talk more.
- Check MongoDB Atlas — is the `analyses` collection getting documents?

---

## Self-Healing Loop Issues

### Prompt version stays at v1 forever
**Possible reasons:**
1. Your calls are all scoring ≥90 (no patch needed) — try ending a call abruptly, ignoring the customer, or being terse
2. `generateAndApplyPatch` is silently failing — check backend logs for "Self-healing patch generation failed"
3. Gemini is returning malformed JSON from the meta-prompt — also visible in logs

### Patches feel generic / unhelpful
The meta-prompt (`buildSelfHealingPrompt` in `analysisPrompts.ts`) is designed to be conservative — it produces small, surgical patches. If you want more aggressive patches, increase the `slice(0, 3)` to include more failures, or lower the score threshold from 90.

---

## Frontend Issues

### Blank page
- Open browser console — JavaScript error?
- Did Vite finish starting? Look for `ready in ...ms` in terminal 2
- Hard reload: Cmd/Ctrl + Shift + R

### Dashboard charts don't render
- Open browser console for Recharts warnings
- The analysis API might be returning an empty array — check `Network → /api/analysis/:callId`

### "Tailwind classes not applying"
- This is Tailwind v4 — make sure `@tailwindcss/vite` is installed (it's in `client/package.json` devDependencies)
- Restart `vite` after any changes to `index.css` `@theme` block
- If you upgraded from v3, delete `node_modules` and reinstall

---

## Production Deploy Issues

This project ships without a Dockerfile. To deploy on Railway/Render/Vercel:

- **Backend:** `cd server && npm install && npm run build && npm start` — port from env
- **Frontend:** `cd client && npm install && npm run build` — serve `dist/`
- **Important:** Set `CLIENT_URL` env var to your deployed frontend domain (CORS)
- **MongoDB:** Switch to Atlas connection string if using Mongo

For LiveKit + Socket.IO on the same domain, no special CORS config needed. For separate domains, add the frontend domain to the CORS allowlist in `server/src/index.ts`.

---

## Getting More Help

- Backend logs are your friend — almost every issue shows up there
- Use the health endpoint: `curl http://localhost:3001/api/health`
- For Gemini-specific issues: https://ai.google.dev
- For LiveKit issues: https://docs.livekit.io
- For Deepgram issues: https://developers.deepgram.com
