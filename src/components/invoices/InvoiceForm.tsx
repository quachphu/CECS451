'use client';

import { useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { z } from 'zod';
import { Plus, Trash2, Sparkles, Loader2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import { IClient, IInvoice } from '@/types';
import { formatCurrency } from '@/lib/utils';

const schema = z.object({
  clientId: z.string().min(1, 'Select a client'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1, 'Description required'),
        quantity: z.number().min(0),
        rate: z.number().min(0),
      })
    )
    .min(1, 'Add at least one item'),
  taxRate: z.number().min(0).max(100),
  status: z.enum(['draft', 'sent', 'paid', 'overdue']),
  dueDate: z.string().min(1, 'Due date is required'),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

interface InvoiceFormProps {
  clients: IClient[];
  initial?: Partial<IInvoice>;
  onSubmit: (data: FormData) => Promise<void>;
  submitLabel?: string;
}

export default function InvoiceForm({ clients, initial, onSubmit, submitLabel = 'Save Invoice' }: InvoiceFormProps) {
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      clientId: typeof initial?.clientId === 'object' ? (initial.clientId as IClient)._id : initial?.clientId ?? '',
      title: initial?.title ?? '',
      description: initial?.description ?? '',
      lineItems: initial?.lineItems?.length
        ? initial.lineItems.map((li) => ({ description: li.description, quantity: li.quantity, rate: li.rate }))
        : [{ description: '', quantity: 1, rate: 0 }],
      taxRate: initial?.taxRate ?? 0,
      status: initial?.status ?? 'draft',
      dueDate: initial?.dueDate ? new Date(initial.dueDate).toISOString().split('T')[0] : '',
      notes: initial?.notes ?? '',
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'lineItems' });
  const lineItems = watch('lineItems');
  const taxRate = watch('taxRate');

  const subtotal = lineItems?.reduce((sum, item) => sum + (item.quantity || 0) * (item.rate || 0), 0) ?? 0;
  const tax = (subtotal * (taxRate || 0)) / 100;
  const total = subtotal + tax;

  async function handleAiSuggest() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setAiError('');
    try {
      const res = await fetch('/api/ai/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      if (data.data.title) setValue('title', data.data.title);
      if (data.data.description) setValue('description', data.data.description);
      if (data.data.lineItems?.length) {
        const items = data.data.lineItems.map((li: { description: string; quantity: number; rate: number }) => ({
          description: li.description,
          quantity: li.quantity ?? 1,
          rate: li.rate ?? 0,
        }));
        setValue('lineItems', items);
      }
    } catch (err: unknown) {
      setAiError(err instanceof Error ? err.message : 'AI suggestion failed');
    } finally {
      setAiLoading(false);
    }
  }

  async function onFormSubmit(data: FormData) {
    setSubmitting(true);
    try {
      await onSubmit(data);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
      {/* AI Suggest */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={16} className="text-blue-600" />
          <span className="text-sm font-semibold text-blue-800">AI Suggest</span>
          <span className="text-xs text-blue-500 bg-blue-100 px-2 py-0.5 rounded-full">Powered by Groq</span>
        </div>
        <p className="text-xs text-blue-600 mb-3">Describe your project and let AI fill in the details.</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="e.g. Web design project for a restaurant"
            className="flex-1 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAiSuggest())}
          />
          <Button type="button" onClick={handleAiSuggest} loading={aiLoading} size="sm">
            {aiLoading ? '' : <><Sparkles size={14} /> Suggest</>}
          </Button>
        </div>
        {aiError && <p className="text-xs text-red-600 mt-2">{aiError}</p>}
      </div>

      {/* Basic info */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          id="clientId"
          label="Client *"
          options={clients.map((c) => ({ value: c._id, label: c.name + (c.company ? ` (${c.company})` : '') }))}
          placeholder="Select a client"
          error={errors.clientId?.message}
          {...register('clientId')}
        />
        <Select
          id="status"
          label="Status"
          options={[
            { value: 'draft', label: 'Draft' },
            { value: 'sent', label: 'Sent' },
            { value: 'paid', label: 'Paid' },
            { value: 'overdue', label: 'Overdue' },
          ]}
          {...register('status')}
        />
        <div className="sm:col-span-2">
          <Input id="title" label="Invoice Title *" placeholder="e.g. Website Redesign" error={errors.title?.message} {...register('title')} />
        </div>
        <div className="sm:col-span-2">
          <Textarea id="description" label="Description" placeholder="Brief project summary..." {...register('description')} />
        </div>
        <Input id="dueDate" label="Due Date *" type="date" error={errors.dueDate?.message} {...register('dueDate')} />
        <Input id="taxRate" label="Tax Rate (%)" type="number" min={0} max={100} step={0.5} {...register('taxRate', { valueAsNumber: true })} />
      </div>

      {/* Line Items */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-700">Line Items *</h3>
          <Button type="button" variant="outline" size="sm" onClick={() => append({ description: '', quantity: 1, rate: 0 })}>
            <Plus size={14} /> Add Item
          </Button>
        </div>

        <div className="space-y-2">
          {fields.map((field, idx) => (
            <div key={field.id} className="grid grid-cols-12 gap-2 items-start">
              <div className="col-span-6">
                <input
                  placeholder="Description"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  {...register(`lineItems.${idx}.description`)}
                />
                {errors.lineItems?.[idx]?.description && (
                  <p className="text-xs text-red-600 mt-0.5">{errors.lineItems[idx]?.description?.message}</p>
                )}
              </div>
              <div className="col-span-2">
                <input
                  type="number"
                  placeholder="Qty"
                  min={0}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  {...register(`lineItems.${idx}.quantity`, { valueAsNumber: true })}
                />
              </div>
              <div className="col-span-3">
                <input
                  type="number"
                  placeholder="Rate (₹)"
                  min={0}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  {...register(`lineItems.${idx}.rate`, { valueAsNumber: true })}
                />
              </div>
              <div className="col-span-1 flex justify-end pt-2">
                {fields.length > 1 && (
                  <button type="button" onClick={() => remove(idx)} className="text-slate-400 hover:text-red-500 transition-colors">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {errors.lineItems?.root?.message && (
          <p className="text-xs text-red-600 mt-1">{errors.lineItems.root.message}</p>
        )}

        {/* Totals */}
        <div className="mt-4 ml-auto w-full max-w-xs space-y-1">
          <div className="flex justify-between text-sm text-slate-600">
            <span>Subtotal</span>
            <span>{formatCurrency(subtotal)}</span>
          </div>
          {taxRate > 0 && (
            <div className="flex justify-between text-sm text-slate-600">
              <span>Tax ({taxRate}%)</span>
              <span>{formatCurrency(tax)}</span>
            </div>
          )}
          <div className="flex justify-between text-base font-bold text-slate-900 border-t border-slate-200 pt-1">
            <span>Total</span>
            <span>{formatCurrency(total)}</span>
          </div>
        </div>
      </div>

      <Textarea id="notes" label="Notes" placeholder="Payment instructions, terms, etc." {...register('notes')} />

      <div className="flex justify-end gap-3 pt-2">
        <Button type="submit" loading={submitting} size="lg">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
