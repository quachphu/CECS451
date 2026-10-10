export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue';
export type ExpenseCategory =
  | 'Tools'
  | 'Marketing'
  | 'Utilities'
  | 'Travel'
  | 'Food'
  | 'Office'
  | 'Other';

export interface IUser {
  _id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface IClient {
  _id: string;
  userId: string;
  name: string;
  email: string;
  phone?: string;
  address?: string;
  company?: string;
  createdAt: string;
}

export interface ILineItem {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
}

export interface IInvoice {
  _id: string;
  userId: string;
  clientId: string | IClient;
  invoiceNumber: string;
  title: string;
  description?: string;
  lineItems: ILineItem[];
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  status: InvoiceStatus;
  dueDate: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IExpense {
  _id: string;
  userId: string;
  title: string;
  amount: number;
  category: ExpenseCategory;
  date: string;
  notes?: string;
  createdAt: string;
}

export interface IDashboardStats {
  totalRevenue: number;
  pendingAmount: number;
  overdueAmount: number;
  totalExpenses: number;
  invoiceCount: number;
  paidCount: number;
  pendingCount: number;
  overdueCount: number;
  recentInvoices: IInvoice[];
  monthlyRevenue: { month: string; revenue: number; expenses: number }[];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
