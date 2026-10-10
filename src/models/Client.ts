import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IClientDocument extends Document {
  userId: Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  address?: string;
  company?: string;
  createdAt: Date;
}

const ClientSchema = new Schema<IClientDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    company: { type: String, trim: true },
  },
  { timestamps: true }
);

export default mongoose.models.Client || mongoose.model<IClientDocument>('Client', ClientSchema);
