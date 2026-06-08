export type Speaker = 'Agent' | 'Customer';
export type Sentiment = 'positive' | 'neutral' | 'frustrated' | 'angry';
export type CallFlowStage = 'Greeting' | 'Discovery' | 'Resolution Attempt' | 'Objection Handling' | 'Escalation' | 'Close';

export interface TranscriptTurn {
  turnIndex: number;
  timestamp: string;
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs?: number;
}

export interface SentimentArcEntry {
  turn: number;
  timestamp: string;
  text_preview: string;
  sentiment: Sentiment;
  escalation_trigger: boolean;
}

export interface CallFlowEntry {
  turn: number;
  timestamp: string;
  speaker: Speaker;
  text_preview: string;
  stage: CallFlowStage;
}

export interface FailureMoment {
  timestamp: string;
  type: string;
  description: string;
  agent_text: string;
  customer_text: string;
  severity: 'low' | 'medium' | 'high';
}

export interface Scorecard {
  callId: string;
  rubric_score: number;
  rubric_details: {
    greeted_within_5s: boolean;
    issue_acknowledged_before_solution: boolean;
    policy_explained_clearly: boolean;
    call_closed_with_resolution: boolean;
    no_dead_air_over_3s: boolean;
  };
  sentiment_arc: SentimentArcEntry[];
  call_flow: CallFlowEntry[];
  flags: string[];
  agent_signals: {
    filler_words: number;
    avg_response_length_words: number;
    unresolved_objections: number;
    objection_details: string[];
  };
  failure_moments: FailureMoment[];
  prompt_version: number;
  createdAt?: string;
}

export interface CallRecord {
  callId: string;
  roomName: string;
  startTime: string;
  endTime?: string;
  duration?: number;
  audioFile?: string;
  agentPromptVersion: number;
  status: 'active' | 'completed' | 'failed';
}

export interface PatchInfo {
  patch_type: 'addition' | 'modification';
  target_section: string;
  instruction: string;
  failure_addressed: string;
  reasoning: string;
  example_added: string | null;
}

export interface PromptVersion {
  version: number;
  systemPrompt: string;
  triggeredByCallId?: string;
  rubricScoreBefore?: number;
  patches: PatchInfo[];
  summary: string;
  expectedImprovement: string;
  createdAt: string;
}

// Live call state
export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'active'
  | 'agent_thinking'
  | 'agent_speaking'
  | 'ending'
  | 'analyzing'
  | 'complete'
  | 'error';

export interface LiveTurn {
  id: string;
  speaker: Speaker;
  text: string;
  timestamp: string;
  isInterim?: boolean;
  turnIndex?: number;
}
