import { PromptVersion } from '../../database/models/PromptVersion';
import { buildSelfHealingPrompt, buildTranscriptText } from '../analysis/analysisPrompts';
import { analyzeCall } from '../llm/geminiService';
import { TranscriptTurn } from '../agent/agentPipeline';
import { logger } from '../../utils/logger';
import { parseRobustJson } from '../../utils/jsonUtils';

/**
 * Simple in-process mutex to prevent concurrent calls from creating duplicate
 * prompt versions. Only one patch can run at a time.
 */
let patchInProgress = false;

// Initial NovaTel agent system prompt — v1
const INITIAL_SYSTEM_PROMPT = `You are Sarah, a customer support specialist for NovaTel — a mid-tier telecommunications provider serving residential and small business customers. You handle billing complaints and account disputes via live voice call.

## Your Mission
Resolve customer billing issues with genuine empathy while protecting NovaTel's legitimate business interests. Not every complaint warrants a refund — but every complaint warrants being heard.

## Persona
- Name: Sarah
- Tone: Warm, professional, direct — like a knowledgeable colleague, not a script reader
- Pacing: Short, complete sentences. Pause after questions. Give the customer space to finish.
- NEVER use filler words: no "um", "uh", "like", "you know", "basically", "so yeah"
- You are speaking — not texting. Avoid bullet-reading, lists, or formal writing style.

## NovaTel Billing Policies You Must Know
1. Duplicate charges: Refunded within 3–5 business days, no questions asked. Confirm the charge date and amount before submitting.
2. Late fees ($15/month): Waived once per 12 months for customers with a clean payment history (no more than 1 late payment in 12 months). Requires account number.
3. Plan cancellations: 30-day notice required. Early cancellation: 30-day fee equivalent. Always offer a plan pause (up to 3 months, no charge) before processing cancellation.
4. Billing cycle: Closes on the 1st of each month. Charges this cycle are for services from last month.
5. Manager escalations: After 2 failed resolution attempts, proactively offer a supervisor callback within 2 business hours.

## Required Conversation Stages
1. GREETING — Introduce yourself by name, say NovaTel, ask how you can help. Do this in the FIRST response.
2. DISCOVERY — Ask targeted questions to understand the specific issue. Don't assume the problem.
3. ACKNOWLEDGMENT — Explicitly name the issue before offering any solution ("I understand you were charged $47.99 twice on the 15th...")
4. RESOLUTION — State the specific remedy available under policy, with a clear timeline.
5. CLOSE — Confirm what was done or what happens next. Ask if there's anything else.

## Objection Handling Scripts
- "That's too expensive" → "I hear you. Let's look at your usage and see if there's a plan that fits better — we have options down to $25 a month."
- "I want to cancel" → First: acknowledge, ask why, present alternatives (pause, downgrade). Only process cancellation if customer still wants it after alternatives.
- "I want to speak to a manager" → First time: "I want to make sure I've done everything I can for you first. Can you give me one more chance?" Second time: "Absolutely. I'll schedule a supervisor callback for you within 2 hours. Can I get your best callback number?"
- "This is ridiculous / unacceptable" → Never argue. Validate: "I completely understand your frustration, and honestly, I'd feel the same way. Let's fix this right now."

## Hard Rules
- Never fabricate charges, credits, or policy details
- Never promise a refund without confirming you can authorize it ("I'm submitting that refund request right now — you'll see it in 3–5 business days")
- Never tell a customer they're wrong about a charge — verify first, then explain
- If you don't know: "Let me pull that up for you" — pause, then give your best answer or offer to follow up via email

## Response Length
Keep responses to 2–4 sentences unless explaining a policy (max 5 sentences). If you're going longer, you're rambling.`;

export async function seedInitialPrompt(): Promise<void> {
  const existing = await PromptVersion.findOne({ version: 1 });
  if (existing) {
    logger.info('Prompt v1 already exists');
    return;
  }

  await PromptVersion.create({
    version: 1,
    systemPrompt: INITIAL_SYSTEM_PROMPT,
    summary: 'Initial NovaTel billing support agent prompt',
    patches: [],
    expectedImprovement: 'Baseline',
  });

  logger.info('Seeded initial prompt v1');
}

export async function getCurrentPrompt(): Promise<{ version: number; systemPrompt: string }> {
  const latest = await PromptVersion.findOne().sort({ version: -1 });
  if (!latest) {
    await seedInitialPrompt();
    return { version: 1, systemPrompt: INITIAL_SYSTEM_PROMPT };
  }
  return { version: latest.version, systemPrompt: latest.systemPrompt };
}

export async function generateAndApplyPatch(
  callId: string,
  rubricScore: number,
  failureMoments: unknown[],
  turns: TranscriptTurn[]
): Promise<{ version: number; summary: string } | null> {
  if (rubricScore >= 90) {
    logger.info(`Call ${callId} scored ${rubricScore}/100 — no patch needed`);
    return null;
  }


  // Mutex: skip if another patch is already being generated to prevent version collision
  if (patchInProgress) {
    logger.warn(`Call ${callId}: prompt patch skipped — another patch is already in progress`);
    return null;
  }
  patchInProgress = true;

  const current = await getCurrentPrompt();
  const nextVersion = current.version + 1;
  const formattedTranscript = buildTranscriptText(turns);

  const metaPrompt = buildSelfHealingPrompt(
    current.systemPrompt,
    current.version,
    nextVersion,
    callId,
    rubricScore,
    failureMoments,
    formattedTranscript
  );

  let patch: any = null;
  let retryCount = 0;
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 2500;

  while (retryCount <= MAX_RETRIES) {
    try {
      const rawResponse = await analyzeCall(metaPrompt);
      patch = parseRobustJson(rawResponse);
      
      // Verify minimal patch structure to ensure we have the patches array
      if (!patch || typeof patch !== 'object' || !Array.isArray(patch.patches)) {
        throw new Error('Self-healing patch response is missing required patches array');
      }
      break; // Success!
    } catch (err: any) {
      const errStr = err?.message || String(err);
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        logger.warn(`[selfHealingPrompt] Patch generation attempt ${retryCount}/${MAX_RETRIES + 1} failed (Error: ${errStr.slice(0, 100)}). Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        logger.error(`[selfHealingPrompt] Patch generation failed after ${MAX_RETRIES + 1} attempts for call ${callId}`, err);
        patchInProgress = false; // release lock before throwing/exiting
        return null;
      }
    }
  }

  try {
    // Apply patches to the current prompt
    let newPrompt = current.systemPrompt;
    for (const p of patch.patches || []) {
      if (p.patch_type === 'addition' && p.target_section && p.instruction) {
        const sectionRegex = new RegExp(`(## ${escapeRegex(p.target_section)}[\\s\\S]*?)(?=## |$)`, 'i');
        if (sectionRegex.test(newPrompt)) {
          newPrompt = newPrompt.replace(sectionRegex, (match) => {
            return match.trimEnd() + '\n- ' + p.instruction + (p.example_added ? `\n  Example: ${p.example_added}` : '') + '\n';
          });
        } else {
          newPrompt += `\n\n## Additional Guidance (Auto-patched v${nextVersion})\n- ${p.instruction}`;
        }
      } else if (p.patch_type === 'modification' && p.target_section && p.instruction) {
        newPrompt = newPrompt + `\n\n## Correction (v${nextVersion})\n${p.instruction}`;
      }
    }

    await PromptVersion.create({
      version: nextVersion,
      systemPrompt: newPrompt,
      triggeredByCallId: callId,
      rubricScoreBefore: rubricScore,
      patches: patch.patches || [],
      summary: patch.summary || `Auto-patched after call ${callId}`,
      expectedImprovement: patch.expected_improvement || '',
    });

    logger.info(`Prompt evolved to v${nextVersion} after call ${callId}: ${patch.summary}`);
    return { version: nextVersion, summary: patch.summary };
  } catch (err) {
    logger.error('Self-healing patch application failed', err);
    return null;
  } finally {
    // Always release the mutex — even if an error occurred
    patchInProgress = false;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
