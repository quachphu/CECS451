import mongoose, { Schema, Document, Types } from 'mongoose';
import { InvoiceStatus } from '@/types';

export interface ILineItemDocument {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
}

export interface IInvoiceDocument extends Document {
  userId: Types.ObjectId;
  clientId: Types.ObjectId;
  invoiceNumber: string;
  title: string;
  description?: string;
  lineItems: ILineItemDocument[];
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  status: InvoiceStatus;
  dueDate: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const LineItemSchema = new Schema<ILineItemDocument>(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const InvoiceSchema = new Schema<IInvoiceDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    invoiceNumber: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true },
    lineItems: { type: [LineItemSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['draft', 'sent', 'paid', 'overdue'],
      default: 'draft',
    },
    dueDate: { type: Date, required: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

// Invoice numbers only need to be unique per user, not globally
InvoiceSchema.index({ userId: 1, invoiceNumber: 1 }, { unique: true });

export default mongoose.models.Invoice ||
  mongoose.model<IInvoiceDocument>('Invoice', InvoiceSchema);
