import { analyzeCall } from '../llm/geminiService';
import { buildAnalysisPrompt, buildTranscriptText } from './analysisPrompts';
import { TranscriptTurn } from '../agent/agentPipeline';
import { Analysis } from '../../database/models/Analysis';
import { Transcript } from '../../database/models/Transcript';
import { logger } from '../../utils/logger';
import { parseRobustJson } from '../../utils/jsonUtils';
import { getCurrentPrompt, generateAndApplyPatch } from '../promptEvolution/selfHealingPrompt';

export async function runCallAnalysis(
  callId: string,
  turns: TranscriptTurn[],
  durationSeconds: number,
  deadAirSegments: Array<{ startMs: number; endMs: number; durationMs: number; timestamp: string }>,
  promptVersion: number
): Promise<{ analysis: any; patch: { version: number; summary: string } | null } | null> {
  const formattedTranscript = buildTranscriptText(turns);

  // Save transcript to DB
  try {
    await Transcript.findOneAndUpdate(
      { callId },
      {
        callId,
        turns: turns.map((t) => ({
          turnIndex: t.turnIndex,
          timestamp: t.timestamp,
          speaker: t.speaker,
          text: t.text,
          startMs: t.startMs,
          endMs: t.endMs,
        })),
        deadAirSegments,
        fullText: turns.map((t) => t.text).join(' '),
        formattedTranscript,
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    logger.error('Failed to save transcript', err);
  }

  if (!formattedTranscript.trim() || turns.length < 2) {
    logger.warn(`Call ${callId}: transcript too short to analyze`);
    return null;
  }

  const current = await getCurrentPrompt();
  const nextVersion = current.version + 1;

  const prompt = buildAnalysisPrompt(
    callId,
    formattedTranscript,
    durationSeconds,
    deadAirSegments,
    promptVersion,
    current.systemPrompt,
    nextVersion
  );

  let retryCount = 0;
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 2500;
  let scorecard: any = null;

  while (retryCount <= MAX_RETRIES) {
    try {
      const rawResponse = await analyzeCall(prompt);
      scorecard = parseRobustJson(rawResponse);
      
      // Verify scorecard schema shape minimally to ensure the parse succeeded and isn't garbage
      if (!scorecard || typeof scorecard !== 'object' || scorecard.rubric_score === undefined) {
        throw new Error('Call analysis response is missing required rubric_score field');
      }

      // Recalculate rubric score programmatically to fix LLM addition/logical errors
      let calculatedScore = 0;
      const details = scorecard.rubric_details || {};
      if (details.greeted_within_5s) calculatedScore += 20;
      if (details.issue_acknowledged_before_solution) calculatedScore += 25;
      if (details.policy_explained_clearly) calculatedScore += 20;
      if (details.call_closed_with_resolution) calculatedScore += 20;
      if (details.no_dead_air_over_3s) calculatedScore += 15;
      scorecard.rubric_score = calculatedScore;

      break; // Success!
    } catch (err: any) {
      const errStr = err?.message || String(err);
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        logger.warn(`[runCallAnalysis] Call analysis attempt ${retryCount}/${MAX_RETRIES + 1} failed (Error: ${errStr.slice(0, 100)}). Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        logger.error(`[runCallAnalysis] Call analysis failed after ${MAX_RETRIES + 1} attempts for ${callId}`, err);
        throw err;
      }
    }
  }

  // Extract prompt patch if generated
  const promptPatch = scorecard.prompt_patch;
  const scorecardToSave = { ...scorecard };
  delete scorecardToSave.prompt_patch;

  let appliedPatch: { version: number; summary: string } | null = null;
  if (scorecard.rubric_score < 90 && promptPatch) {
    try {
      appliedPatch = await generateAndApplyPatch(callId, scorecard.rubric_score, promptPatch);
    } catch (patchErr) {
      logger.error('Failed to apply generated prompt patch in post-call analysis', patchErr);
    }
  }

  try {
    // Persist to DB
    const analysis = await Analysis.findOneAndUpdate(
      { callId },
      { ...scorecardToSave, callId, prompt_version: promptVersion },
      { upsert: true, new: true }
    );

    logger.info(`Call ${callId} analyzed — score: ${scorecard.rubric_score}/100`);
    return { analysis, patch: appliedPatch };
  } catch (err) {
    logger.error(`Call analysis database persistence failed for ${callId}`, err);
    throw err;
  }
}
