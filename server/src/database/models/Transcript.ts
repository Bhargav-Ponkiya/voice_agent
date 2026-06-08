import mongoose, { Schema, Document } from 'mongoose';

export interface TranscriptTurn {
  turnIndex: number;
  timestamp: string;
  speaker: 'Agent' | 'Customer';
  text: string;
  startMs: number;
  endMs?: number;
}

export interface DeadAirSegment {
  startMs: number;
  endMs: number;
  durationMs: number;
  timestamp: string;
}

export interface ITranscript extends Document {
  callId: string;
  turns: TranscriptTurn[];
  deadAirSegments: DeadAirSegment[];
  fullText: string;
  formattedTranscript: string;
}

const TranscriptTurnSchema = new Schema<TranscriptTurn>({
  turnIndex: { type: Number, required: true },
  timestamp: { type: String, required: true },
  speaker: { type: String, enum: ['Agent', 'Customer'], required: true },
  text: { type: String, required: true },
  startMs: { type: Number, required: true },
  endMs: { type: Number },
}, { _id: false });

const DeadAirSchema = new Schema<DeadAirSegment>({
  startMs: { type: Number, required: true },
  endMs: { type: Number, required: true },
  durationMs: { type: Number, required: true },
  timestamp: { type: String, required: true },
}, { _id: false });

const TranscriptSchema = new Schema<ITranscript>({
  callId: { type: String, required: true, unique: true, index: true },
  turns: [TranscriptTurnSchema],
  deadAirSegments: [DeadAirSchema],
  fullText: { type: String },
  formattedTranscript: { type: String },
}, { timestamps: true });

export const Transcript = mongoose.model<ITranscript>('Transcript', TranscriptSchema);
