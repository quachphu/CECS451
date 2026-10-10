'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { z } from 'zod';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import Button from '@/components/ui/Button';
import { IExpense } from '@/types';

const CATEGORIES = ['Tools', 'Marketing', 'Utilities', 'Travel', 'Food', 'Office', 'Other'] as const;

const schema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  amount: z.number().min(0, 'Amount must be positive'),
  category: z.enum(CATEGORIES),
  date: z.string().min(1, 'Date is required'),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

interface ExpenseFormProps {
  initial?: Partial<IExpense>;
  onSubmit: (data: FormData) => Promise<void>;
  submitLabel?: string;
}

export default function ExpenseForm({ initial, onSubmit, submitLabel = 'Save Expense' }: ExpenseFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      title: initial?.title ?? '',
      amount: initial?.amount ?? 0,
      category: (initial?.category as (typeof CATEGORIES)[number]) ?? 'Other',
      date: initial?.date ? new Date(initial.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      notes: initial?.notes ?? '',
    },
  });

  async function onFormSubmit(data: FormData) {
    setSubmitting(true);
    try {
      await onSubmit(data);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      <Input id="title" label="Expense Title *" placeholder="e.g. Figma subscription" error={errors.title?.message} {...register('title')} />
      <div className="grid grid-cols-2 gap-4">
        <Input id="amount" label="Amount (₹) *" type="number" min={0} step={0.01} error={errors.amount?.message} {...register('amount', { valueAsNumber: true })} />
        <Input id="date" label="Date *" type="date" error={errors.date?.message} {...register('date')} />
      </div>
      <Select
        id="category"
        label="Category *"
        options={CATEGORIES.map((c) => ({ value: c, label: c }))}
        error={errors.category?.message}
        {...register('category')}
      />
      <Textarea id="notes" label="Notes" placeholder="Optional details..." {...register('notes')} />
      <div className="flex justify-end pt-2">
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
