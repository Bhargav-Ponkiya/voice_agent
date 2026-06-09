import { TranscriptTurn } from '../agent/agentPipeline';

export function buildTranscriptText(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => `${t.timestamp} ${t.speaker}: ${t.text}`)
    .join('\n');
}

export function buildAnalysisPrompt(
  callId: string,
  formattedTranscript: string,
  durationSeconds: number,
  deadAirSegments: Array<{ startMs: number; endMs: number; durationMs: number; timestamp: string }>,
  promptVersion: number,
  currentPrompt: string,
  nextVersion: number
): string {
  const deadAirSummary = deadAirSegments.length > 0
    ? deadAirSegments.map((s) => `  - ${s.timestamp} gap of ${(s.durationMs / 1000).toFixed(1)}s`).join('\n')
    : '  - None detected';

  return `You are a quality assurance analyst and prompt optimization system for an AI voice agent at a telecom company. Analyze the following call transcript and return a structured JSON scorecard. Base every finding STRICTLY on the transcript text.

TRANSCRIPT:
${formattedTranscript}

CALL METADATA:
- Call ID: ${callId}
- Duration: ${durationSeconds} seconds
- Dead air segments detected:
${deadAirSummary}
- Prompt version: ${promptVersion}

CURRENT AGENT SYSTEM PROMPT (version ${promptVersion}):
<current_prompt>
${currentPrompt}
</current_prompt>

Return ONLY valid JSON (no markdown, no explanation, no code fences) in exactly this format.
CRITICAL: Ensure your JSON strictly follows RFC 8259 formatting. Escape all quotes inside strings as \\" and encode all newlines inside strings as \\n. DO NOT output any raw newlines or unescaped quotes inside any string value, as this will crash the JSON parser.

{
  "call_id": "${callId}",
  "rubric_score": 0,
  "rubric_details": {
    "greeted_within_5s": true,
    "issue_acknowledged_before_solution": true,
    "policy_explained_clearly": true,
    "call_closed_with_resolution": true,
    "no_dead_air_over_3s": true
  },
  "sentiment_arc": [
    {
      "turn": 0,
      "timestamp": "12:00:00",
      "text_preview": "string",
      "sentiment": "positive",
      "escalation_trigger": true
    }
  ],
  "call_flow": [
    {
      "turn": 0,
      "timestamp": "12:00:00",
      "speaker": "Agent",
      "text_preview": "string",
      "stage": "Greeting"
    }
  ],
  "flags": ["dead_air_at_00:42", "escalation_at_01:15"],
  "agent_signals": {
    "filler_words": 0,
    "avg_response_length_words": 0,
    "unresolved_objections": 0,
    "objection_details": ["string"]
  },
  "failure_moments": [
    {
      "timestamp": "12:00:00",
      "type": "dead_air",
      "description": "string",
      "agent_text": "string",
      "customer_text": "string",
      "severity": "low"
    }
  ],
  "prompt_patch": {
    "patches": [
      {
        "patch_type": "addition",
        "target_section": "string",
        "instruction": "string",
        "failure_addressed": "string",
        "reasoning": "string",
        "example_added": "string"
      }
    ],
    "expected_improvement": "string",
    "summary": "string"
  }
}

If "rubric_score" is 90 or above, set "prompt_patch" to null.
If "rubric_score" is less than 90, you MUST generate a minimal, surgical patch to the agent's system prompt to address the identified failure moments (especially high/medium severity ones) under the "prompt_patch" property.

Rules for generating the prompt patch:
1. Address the HIGHEST SEVERITY failure first.
2. Be SPECIFIC — reference the exact failure pattern with an example from the transcript.
3. Be MINIMAL — add only what is missing, don't rewrite working sections.
4. Add CONCRETE EXAMPLES where the failure was a style/tone issue.
5. Do NOT introduce new constraints that contradict passing behaviors.
6. Limit to maximum 2 patches.
7. Set target_section to the header name in the system prompt where the patch should be applied (e.g. "Persona", "Objection Handling Scripts", "Hard Rules"). If it's a new section, specify the section header name.
8. Set patch_type to "addition" or "modification".

Rubric scoring:
- greeted_within_5s = 20 points (agent introduced self + NovaTel in first turn)
- issue_acknowledged_before_solution = 25 points
- policy_explained_clearly = 20 points
- call_closed_with_resolution = 20 points
- no_dead_air_over_3s = 15 points (based on dead air segments above)

Sentiment detection guide (per customer turn):
- positive: thanks, appreciation, "that makes sense", calm tone, accepts resolution
- neutral: questions, information exchange, no emotion either way (DEFAULT)
- frustrated: "ridiculous", "wrong", "overcharged", "this is unfair", "I've been waiting", repeated complaints
- angry: "unacceptable", "outrageous", multiple !!!, ALL-CAPS WORDS, threats, demands to escalate

Escalation triggers (REQUIRED — set escalation_trigger=true on any customer turn matching):
- Literal phrases: "cancel", "speak to a manager", "supervisor", "lawyer", "lawsuit", "BBB", "Better Business Bureau", "report you", "file a complaint"
- Raised tone signals: ALL-CAPS words (3+ chars), multiple exclamation marks (!!!), or multiple question marks (???)
- Repeated pattern: customer raises the same complaint after the agent has already given two resolution attempts

Filler word counting (REQUIRED — count occurrences in AGENT turns only):
Count any of: "um", "uh", "like" (used as filler, not comparison), "you know", "basically", "so yeah", "I mean", "kind of", "sort of", "actually" (when used to backtrack). Lowercase comparison, whole-word match. Report the total integer in agent_signals.filler_words.

Flags formatting (REQUIRED):
- Every flag string must follow the pattern "<event>_at_MM:SS" (e.g. "dead_air_at_00:42", "escalation_at_01:15", "filler_burst_at_00:08")
- Use snake_case for event names, mm:ss timestamps drawn from the transcript turn timestamps
- Include flags for: any dead air segment listed above, any escalation_trigger=true in sentiment_arc, and any unresolved_objection moment
- If nothing notable happened, return an empty array []

The failure_moments array is critical — be specific and actionable.`;
}

export function buildSelfHealingPrompt(
  currentPrompt: string,
  currentVersion: number,
  nextVersion: number,
  callId: string,
  rubricScore: number,
  failureMoments: unknown[],
  formattedTranscript: string
): string {
  const highSeverityFailures = (failureMoments as Array<{ severity: string }>)
    .filter((f) => f.severity === 'high' || f.severity === 'medium')
    .slice(0, 3);

  return `You are a voice agent optimization system. A customer support call has just completed and QA analysis identified specific performance failures. Your job is to generate a minimal, surgical patch to the agent's system prompt that addresses these failures without breaking what's working.

CURRENT AGENT SYSTEM PROMPT (version ${currentVersion}):
<current_prompt>
${currentPrompt}
</current_prompt>

CALL QA SCORE: ${rubricScore}/100

HIGH-SEVERITY FAILURE MOMENTS FROM THIS CALL:
<failures>
${JSON.stringify(highSeverityFailures, null, 2)}
</failures>

FULL CALL TRANSCRIPT (for context):
<transcript>
${formattedTranscript}
</transcript>

Generate a prompt patch. Rules:
1. Address the HIGHEST SEVERITY failure first
2. Be SPECIFIC — reference the exact failure pattern with an example from the transcript
3. Be MINIMAL — add only what is missing, don't rewrite working sections
4. Add CONCRETE EXAMPLES where the failure was a style/tone issue
5. Do NOT introduce new constraints that contradict passing behaviors

Return ONLY valid JSON, no markdown, no code fences.
CRITICAL: Ensure your JSON strictly follows RFC 8259 formatting. Escape all quotes inside strings as \\" and encode all newlines inside strings as \\n. DO NOT output any raw newlines or unescaped quotes inside any string value, as this will crash the JSON parser.

{
  "patch_version": ${nextVersion},
  "triggered_by_call_id": "${callId}",
  "rubric_score_before": ${rubricScore},
  "patches": [
    {
      "patch_type": "addition",
      "target_section": "string",
      "instruction": "string",
      "failure_addressed": "string",
      "reasoning": "string",
      "example_added": "string"
    }
  ],
  "expected_improvement": "string",
  "summary": "string"
}

Limit to maximum 2 patches. Quality over quantity.`;
}
