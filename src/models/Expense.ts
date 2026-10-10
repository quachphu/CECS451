import mongoose, { Schema, Document, Types } from 'mongoose';
import { ExpenseCategory } from '@/types';

export interface IExpenseDocument extends Document {
  userId: Types.ObjectId;
  title: string;
  amount: number;
  category: ExpenseCategory;
  date: Date;
  notes?: string;
  createdAt: Date;
}

const ExpenseSchema = new Schema<IExpenseDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    amount: { type: Number, required: true, min: 0 },
    category: {
      type: String,
      enum: ['Tools', 'Marketing', 'Utilities', 'Travel', 'Food', 'Office', 'Other'],
      required: true,
    },
    date: { type: Date, required: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

export default mongoose.models.Expense ||
  mongoose.model<IExpenseDocument>('Expense', ExpenseSchema);
