import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import Client from '@/models/Client';
import Invoice from '@/models/Invoice';
import Expense from '@/models/Expense';
import { getAuthUser } from '@/lib/auth';

// Dates for the last 6 months (relative to May 2026)
function monthDate(monthsAgo: number, day: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(day);
  d.setHours(12, 0, 0, 0);
  return d;
}

function inv(
  userId: mongoose.Types.ObjectId,
  clientId: mongoose.Types.ObjectId,
  num: string,
  title: string,
  description: string,
  lineItems: { description: string; quantity: number; rate: number }[],
  taxRate: number,
  status: 'draft' | 'sent' | 'paid' | 'overdue',
  dueDaysFromNow: number,
  paidMonthsAgo: number,
  paidDay: number,
  notes?: string
) {
  const computedItems = lineItems.map((li) => ({ ...li, amount: li.quantity * li.rate }));
  const subtotal = computedItems.reduce((s, li) => s + li.amount, 0);
  const tax = Math.round(subtotal * (taxRate / 100));
  const total = subtotal + tax;
  const due = new Date();
  due.setDate(due.getDate() + dueDaysFromNow);
  const paidDate = monthDate(paidMonthsAgo, paidDay);

  return {
    _id: new mongoose.Types.ObjectId(),
    userId,
    clientId,
    invoiceNumber: num,
    title,
    description,
    lineItems: computedItems,
    subtotal,
    taxRate,
    tax,
    total,
    status,
    dueDate: due,
    notes,
    createdAt: paidDate,
    updatedAt: paidDate,
  };
}

export async function POST() {
  try {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  await connectDB();
  const userId = new mongoose.Types.ObjectId(auth.userId);

  // Drop the old global unique index on invoiceNumber if it still exists
  // (replaced by compound index on userId+invoiceNumber in the schema)
  try {
    await Invoice.collection.dropIndex('invoiceNumber_1');
  } catch {
    // Index doesn't exist — that's fine
  }

  // 4-char hex suffix unique to this user — prevents duplicate invoiceNumber across users
  const u = auth.userId.slice(-4).toUpperCase();

  // Wipe existing data for this user
  await Promise.all([
    Client.deleteMany({ userId }),
    Invoice.deleteMany({ userId }),
    Expense.deleteMany({ userId }),
  ]);

  // ── Clients ──────────────────────────────────────────────────────────────
  const clientDocs = await Client.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(), userId,
      name: 'Acme Technologies', email: 'acme@acmetech.in',
      company: 'Acme Technologies Pvt. Ltd.', phone: '+91 98201 11234',
      createdAt: monthDate(5, 3), updatedAt: monthDate(5, 3),
    },
    {
      _id: new mongoose.Types.ObjectId(), userId,
      name: 'Rohan Mehta', email: 'rohan@blueocean.io',
      company: 'BlueOcean Digital', phone: '+91 97432 55678',
      createdAt: monthDate(5, 5), updatedAt: monthDate(5, 5),
    },
    {
      _id: new mongoose.Types.ObjectId(), userId,
      name: 'Neha Gupta', email: 'neha@sunriseconsult.com',
      company: 'Sunrise Consulting', phone: '+91 93201 88901',
      createdAt: monthDate(4, 8), updatedAt: monthDate(4, 8),
    },
    {
      _id: new mongoose.Types.ObjectId(), userId,
      name: 'TechVista Solutions', email: 'billing@techvista.co',
      company: 'TechVista Solutions LLP', phone: '+91 88001 33445',
      createdAt: monthDate(4, 10), updatedAt: monthDate(4, 10),
    },
    {
      _id: new mongoose.Types.ObjectId(), userId,
      name: 'Simran Kaur', email: 'simran@redleafcreative.in',
      company: 'RedLeaf Creative Studio', phone: '+91 99001 77654',
      createdAt: monthDate(3, 2), updatedAt: monthDate(3, 2),
    },
    {
      _id: new mongoose.Types.ObjectId(), userId,
      name: 'Vikram Nair', email: 'vikram@innovatemind.io',
      company: 'InnovateMind Labs', phone: '+91 91234 56789',
      createdAt: monthDate(2, 7), updatedAt: monthDate(2, 7),
    },
  ]);

  const cid = Object.values(clientDocs.insertedIds) as mongoose.Types.ObjectId[];
  const [acme, blueocean, sunrise, techvista, redleaf, innovate] = cid;

  // ── Invoices ─────────────────────────────────────────────────────────────
  // Paid invoices — spread across 6 months (updatedAt drives the chart)
  const invoiceDocs = [
    // Dec 2025
    inv(userId, acme,      `INV-${u}-2512A`, 'Website Redesign Phase 1',
      'Complete overhaul of homepage and product pages.',
      [{ description: 'UI/UX Design', quantity: 40, rate: 350 },
       { description: 'Frontend Development', quantity: 30, rate: 400 }],
      18, 'paid', -180, 5, 15,
      'Net-30 terms. Payment received on time.'),

    inv(userId, blueocean, `INV-${u}-2512B`, 'Brand Identity Package',
      'Full brand kit including logo, colors, and typography guide.',
      [{ description: 'Logo Design', quantity: 1, rate: 8000 },
       { description: 'Brand Guidelines Document', quantity: 1, rate: 6000 },
       { description: 'Social Media Assets', quantity: 10, rate: 400 }],
      0, 'paid', -160, 5, 22),

    // Jan 2026
    inv(userId, sunrise,   `INV-${u}-2601A`, 'SEO Audit & Strategy',
      'Technical SEO audit and 3-month content strategy.',
      [{ description: 'Technical SEO Audit', quantity: 1, rate: 12000 },
       { description: 'Keyword Research Report', quantity: 1, rate: 7000 },
       { description: 'Content Calendar (3 months)', quantity: 1, rate: 4000 }],
      18, 'paid', -130, 4, 18),

    inv(userId, techvista, `INV-${u}-2601B`, 'Mobile App UI Design',
      'Figma UI designs for iOS and Android application.',
      [{ description: 'Wireframes (20 screens)', quantity: 20, rate: 800 },
       { description: 'High-fidelity Mockups', quantity: 20, rate: 1000 }],
      0, 'paid', -120, 4, 28),

    // Feb 2026
    inv(userId, acme,      `INV-${u}-2602A`, 'E-Commerce Integration',
      'WooCommerce setup and payment gateway integration.',
      [{ description: 'WooCommerce Configuration', quantity: 1, rate: 15000 },
       { description: 'Payment Gateway (Razorpay)', quantity: 1, rate: 8000 },
       { description: 'Product Catalogue Upload', quantity: 50, rate: 100 }],
      18, 'paid', -95, 3, 15),

    inv(userId, redleaf,   `INV-${u}-2602B`, 'Social Media Campaign',
      'Creatives and copy for 6-week Instagram/LinkedIn campaign.',
      [{ description: 'Campaign Strategy', quantity: 1, rate: 10000 },
       { description: 'Creative Posts (30)', quantity: 30, rate: 600 },
       { description: 'Copywriting', quantity: 30, rate: 200 }],
      0, 'paid', -85, 3, 25),

    // Mar 2026
    inv(userId, blueocean, `INV-${u}-2603A`, 'Landing Page Development',
      'High-converting SaaS landing page with A/B test variants.',
      [{ description: 'Landing Page Design', quantity: 1, rate: 12000 },
       { description: 'React Development', quantity: 20, rate: 500 },
       { description: 'A/B Variant (2 pages)', quantity: 2, rate: 3000 }],
      18, 'paid', -65, 2, 20),

    inv(userId, innovate,  `INV-${u}-2603B`, 'Backend API Development',
      'REST API for user authentication and data management.',
      [{ description: 'API Architecture Design', quantity: 1, rate: 8000 },
       { description: 'Node.js API Development', quantity: 40, rate: 450 }],
      0, 'paid', -55, 2, 28),

    // Apr 2026
    inv(userId, techvista, `INV-${u}-2604A`, 'Dashboard UI/UX Design',
      'Admin dashboard design for SaaS analytics platform.',
      [{ description: 'User Research & Wireframes', quantity: 1, rate: 12000 },
       { description: 'Dashboard Design (15 screens)', quantity: 15, rate: 1200 },
       { description: 'Developer Handoff (Zeplin)', quantity: 1, rate: 4000 }],
      18, 'paid', -28, 1, 15),

    inv(userId, sunrise,   `INV-${u}-2604B`, 'Content Writing Package',
      '10 long-form SEO articles for the company blog.',
      [{ description: 'SEO Blog Articles (2000 words)', quantity: 10, rate: 4000 },
       { description: 'Content Editing & Formatting', quantity: 10, rate: 500 }],
      0, 'paid', -20, 1, 25),

    // May 2026 — recently paid
    inv(userId, acme,      `INV-${u}-2605A`, 'Full-Stack Web Application',
      'Inventory management system with React + Node.js.',
      [{ description: 'Project Planning & Architecture', quantity: 1, rate: 8000 },
       { description: 'Frontend Development (React)', quantity: 50, rate: 400 },
       { description: 'Backend Development (Node)', quantity: 35, rate: 400 },
       { description: 'Testing & Deployment', quantity: 1, rate: 5000 }],
      18, 'paid', -8, 0, 12),

    // Pending (sent) — not yet paid
    inv(userId, redleaf,   `INV-${u}-2605B`, 'Brand Refresh & Rebranding',
      'Updated logo, colour palette, and brand voice document.',
      [{ description: 'Brand Strategy Session', quantity: 1, rate: 8000 },
       { description: 'Logo Redesign (3 concepts)', quantity: 1, rate: 12000 },
       { description: 'Brand Book (40 pages)', quantity: 1, rate: 10000 }],
      18, 'sent', 14, 0, 20),

    inv(userId, innovate,  `INV-${u}-2605C`, 'API Performance Optimisation',
      'Profiling and tuning of existing Node.js microservices.',
      [{ description: 'Performance Audit', quantity: 1, rate: 10000 },
       { description: 'Optimisation & Refactor', quantity: 20, rate: 600 }],
      18, 'sent', 21, 0, 21),

    // Overdue
    inv(userId, blueocean, `INV-${u}-2604C`, 'Email Marketing Setup',
      'Mailchimp automation sequences and template design.',
      [{ description: 'Email Template Design (5)', quantity: 5, rate: 2500 },
       { description: 'Automation Workflow Setup', quantity: 1, rate: 8000 }],
      0, 'overdue', -15, 1, 5,
      'Follow up sent twice. Client unresponsive.'),

    // Draft
    inv(userId, techvista, `INV-${u}-2605D`, 'Mobile App Development Phase 2',
      'Implementing push notifications and offline mode.',
      [{ description: 'Push Notification Integration', quantity: 1, rate: 12000 },
       { description: 'Offline Mode & Sync', quantity: 25, rate: 500 }],
      18, 'draft', 30, 0, 24),
  ];

  await Invoice.collection.insertMany(invoiceDocs);

  // ── Expenses ─────────────────────────────────────────────────────────────
  await Expense.collection.insertMany([
    // Dec 2025
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Notion Business Plan', amount: 3500, category: 'Tools',
      date: monthDate(5, 8),  notes: 'Annual subscription', createdAt: monthDate(5, 8),  updatedAt: monthDate(5, 8) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'AWS Cloud Hosting',   amount: 4800, category: 'Utilities',
      date: monthDate(5, 12), notes: 'EC2 + S3 + CloudFront', createdAt: monthDate(5, 12), updatedAt: monthDate(5, 12) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Office Supplies',     amount: 7200, category: 'Office',
      date: monthDate(5, 18), notes: 'Desk organiser, stationery, printer cartridges', createdAt: monthDate(5, 18), updatedAt: monthDate(5, 18) },

    // Jan 2026
    { _id: new mongoose.Types.ObjectId(), userId, title: 'GitHub Copilot',      amount: 2000, category: 'Tools',
      date: monthDate(4, 5),  notes: 'Monthly subscription', createdAt: monthDate(4, 5),  updatedAt: monthDate(4, 5) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Google Ads Campaign', amount: 8000, category: 'Marketing',
      date: monthDate(4, 10), notes: 'Lead generation for Q1', createdAt: monthDate(4, 10), updatedAt: monthDate(4, 10) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Electricity Bill',    amount: 4500, category: 'Utilities',
      date: monthDate(4, 20), createdAt: monthDate(4, 20), updatedAt: monthDate(4, 20) },

    // Feb 2026
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Figma Professional',  amount: 5000, category: 'Tools',
      date: monthDate(3, 3),  notes: 'Annual plan upgrade', createdAt: monthDate(3, 3),  updatedAt: monthDate(3, 3) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'LinkedIn Ads',        amount: 10000, category: 'Marketing',
      date: monthDate(3, 10), notes: 'B2B outreach campaign', createdAt: monthDate(3, 10), updatedAt: monthDate(3, 10) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Coworking Space',     amount: 8000, category: 'Office',
      date: monthDate(3, 15), notes: '91springboard monthly pass', createdAt: monthDate(3, 15), updatedAt: monthDate(3, 15) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Client Lunch Meeting', amount: 2000, category: 'Food',
      date: monthDate(3, 22), notes: 'Meeting with Acme team', createdAt: monthDate(3, 22), updatedAt: monthDate(3, 22) },

    // Mar 2026
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Vercel Pro',          amount: 3000, category: 'Tools',
      date: monthDate(2, 5),  createdAt: monthDate(2, 5),  updatedAt: monthDate(2, 5) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Facebook Ads',        amount: 8500, category: 'Marketing',
      date: monthDate(2, 12), notes: 'Retargeting campaign', createdAt: monthDate(2, 12), updatedAt: monthDate(2, 12) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Home Office Internet', amount: 3500, category: 'Utilities',
      date: monthDate(2, 18), notes: 'Airtel fibre quarterly', createdAt: monthDate(2, 18), updatedAt: monthDate(2, 18) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Business Travel (Mumbai)', amount: 4000, category: 'Travel',
      date: monthDate(2, 25), notes: 'Train + accommodation for client meeting', createdAt: monthDate(2, 25), updatedAt: monthDate(2, 25) },

    // Apr 2026
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Ahrefs SEO Tool',     amount: 7000, category: 'Tools',
      date: monthDate(1, 4),  notes: 'Monthly plan for SEO research', createdAt: monthDate(1, 4),  updatedAt: monthDate(1, 4) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Instagram Ads',       amount: 6000, category: 'Marketing',
      date: monthDate(1, 10), notes: 'Portfolio showcase campaign', createdAt: monthDate(1, 10), updatedAt: monthDate(1, 10) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Electricity & WiFi',  amount: 4500, category: 'Utilities',
      date: monthDate(1, 15), createdAt: monthDate(1, 15), updatedAt: monthDate(1, 15) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Client Travel (Bengaluru)', amount: 9000, category: 'Travel',
      date: monthDate(1, 20), notes: 'Flight + 2 nights stay for TechVista onsite', createdAt: monthDate(1, 20), updatedAt: monthDate(1, 20) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Team Dinner',         amount: 4500, category: 'Food',
      date: monthDate(1, 28), notes: 'Project completion celebration', createdAt: monthDate(1, 28), updatedAt: monthDate(1, 28) },

    // May 2026
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Postman Team Plan',   amount: 2500, category: 'Tools',
      date: monthDate(0, 5),  createdAt: monthDate(0, 5),  updatedAt: monthDate(0, 5) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Google Workspace',    amount: 3200, category: 'Tools',
      date: monthDate(0, 10), notes: 'Business email & Drive', createdAt: monthDate(0, 10), updatedAt: monthDate(0, 10) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Office Chair (Ergonomic)', amount: 12000, category: 'Office',
      date: monthDate(0, 15), notes: 'Work-from-home upgrade', createdAt: monthDate(0, 15), updatedAt: monthDate(0, 15) },
    { _id: new mongoose.Types.ObjectId(), userId, title: 'Client Lunch',        amount: 1800, category: 'Food',
      date: monthDate(0, 20), createdAt: monthDate(0, 20), updatedAt: monthDate(0, 20) },
  ]);

  return NextResponse.json({
    success: true,
    message: 'Sample data loaded — 6 clients, 15 invoices, 23 expenses.',
  });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
