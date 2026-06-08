import mongoose, { Schema, Document } from 'mongoose';

export interface SentimentArcEntry {
  turn: number;
  timestamp: string;
  text_preview: string;
  sentiment: 'positive' | 'neutral' | 'frustrated' | 'angry';
  escalation_trigger: boolean;
}

export interface CallFlowEntry {
  turn: number;
  timestamp: string;
  speaker: 'Agent' | 'Customer';
  text_preview: string;
  stage: 'Greeting' | 'Discovery' | 'Resolution Attempt' | 'Objection Handling' | 'Escalation' | 'Close';
}

export interface FailureMoment {
  timestamp: string;
  type: string;
  description: string;
  agent_text: string;
  customer_text: string;
  severity: 'low' | 'medium' | 'high';
}

export interface IAnalysis extends Document {
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
}

const AnalysisSchema = new Schema<IAnalysis>({
  callId: { type: String, required: true, unique: true, index: true },
  rubric_score: { type: Number, required: true },
  rubric_details: {
    greeted_within_5s: Boolean,
    issue_acknowledged_before_solution: Boolean,
    policy_explained_clearly: Boolean,
    call_closed_with_resolution: Boolean,
    no_dead_air_over_3s: Boolean,
  },
  sentiment_arc: [{ type: Schema.Types.Mixed }],
  call_flow: [{ type: Schema.Types.Mixed }],
  flags: [String],
  agent_signals: {
    filler_words: Number,
    avg_response_length_words: Number,
    unresolved_objections: Number,
    objection_details: [String],
  },
  failure_moments: [{ type: Schema.Types.Mixed }],
  prompt_version: { type: Number, required: true },
}, { timestamps: true });

// Index for dashboard sort: `find().sort({ createdAt: -1 })`
AnalysisSchema.index({ createdAt: -1 });

export const Analysis = mongoose.model<IAnalysis>('Analysis', AnalysisSchema);
