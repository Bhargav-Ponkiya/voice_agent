import mongoose, { Schema, Document } from 'mongoose';

export interface PatchInfo {
  patch_type: 'addition' | 'modification';
  target_section: string;
  instruction: string;
  failure_addressed: string;
  reasoning: string;
  example_added: string | null;
}

export interface IPromptVersion extends Document {
  version: number;
  systemPrompt: string;
  triggeredByCallId?: string;
  rubricScoreBefore?: number;
  patches: PatchInfo[];
  summary: string;
  expectedImprovement: string;
  createdAt: Date;
}

const PatchInfoSchema = new Schema<PatchInfo>({
  patch_type: { type: String, enum: ['addition', 'modification'], required: true },
  target_section: String,
  instruction: String,
  failure_addressed: String,
  reasoning: String,
  example_added: String,
}, { _id: false });

const PromptVersionSchema = new Schema<IPromptVersion>({
  version: { type: Number, required: true, unique: true, index: true },
  systemPrompt: { type: String, required: true },
  triggeredByCallId: { type: String },
  rubricScoreBefore: { type: Number },
  patches: [PatchInfoSchema],
  summary: { type: String, default: 'Initial version' },
  expectedImprovement: { type: String, default: '' },
}, { timestamps: true });

export const PromptVersion = mongoose.model<IPromptVersion>('PromptVersion', PromptVersionSchema);
