'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { z } from 'zod';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import { IClient } from '@/types';

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email'),
  phone: z.string().trim().optional(),
  company: z.string().trim().optional(),
  address: z.string().trim().optional(),
});

type FormData = z.infer<typeof schema>;

interface ClientFormProps {
  initial?: Partial<IClient>;
  onSubmit: (data: FormData) => Promise<void>;
  submitLabel?: string;
}

export default function ClientForm({ initial, onSubmit, submitLabel = 'Save Client' }: ClientFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      name: initial?.name ?? '',
      email: initial?.email ?? '',
      phone: initial?.phone ?? '',
      company: initial?.company ?? '',
      address: initial?.address ?? '',
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input id="name" label="Full Name *" placeholder="John Doe" error={errors.name?.message} {...register('name')} />
        <Input id="email" label="Email *" type="email" placeholder="john@example.com" error={errors.email?.message} {...register('email')} />
        <Input id="phone" label="Phone" placeholder="+91 98765 43210" {...register('phone')} />
        <Input id="company" label="Company" placeholder="Acme Corp" {...register('company')} />
        <div className="sm:col-span-2">
          <Input id="address" label="Address" placeholder="123 Main St, City" {...register('address')} />
        </div>
      </div>
      <div className="flex justify-end pt-2">
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
