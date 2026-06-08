import mongoose, { Schema, Document } from 'mongoose';

export interface ICall extends Document {
  callId: string;
  roomName: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  audioFile?: string;
  agentPromptVersion: number;
  status: 'active' | 'completed' | 'failed';
  participantCount: number;
}

const CallSchema = new Schema<ICall>({
  callId: { type: String, required: true, unique: true, index: true },
  roomName: { type: String, required: true },
  startTime: { type: Date, required: true, default: Date.now },
  endTime: { type: Date },
  duration: { type: Number },
  audioFile: { type: String },
  agentPromptVersion: { type: Number, required: true, default: 1 },
  status: { type: String, enum: ['active', 'completed', 'failed'], default: 'active' },
  participantCount: { type: Number, default: 0 },
}, { timestamps: true });

// Compound index: powers the dashboard query `find({ status: 'completed' }).sort({ startTime: -1 })`
CallSchema.index({ status: 1, startTime: -1 });

export const Call = mongoose.model<ICall>('Call', CallSchema);
