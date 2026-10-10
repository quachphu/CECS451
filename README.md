# FinFlow — AI-Powered Invoice & Finance Manager

> Fullstack Developer Assignment — Jan 2026

![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript)
![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose-green?style=flat-square&logo=mongodb)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-38bdf8?style=flat-square&logo=tailwindcss)
![Groq AI](https://img.shields.io/badge/Groq-Llama_3.3-orange?style=flat-square&logo=groq)

---

## What is FinFlow?

FinFlow is a full-stack finance management platform designed for **freelancers and small business owners** who need a simple, powerful way to manage their income and expenses — without the complexity of enterprise accounting software.

The core problem it solves: freelancers often track invoices in spreadsheets, miss payment follow-ups, and have no clear picture of their monthly revenue vs. spending. FinFlow brings all of that into one clean, fast, AI-assisted web application.

**Key differentiator:** A built-in AI assistant (powered by Groq + Llama 3.3) that understands a plain-English project description and automatically generates a professional invoice — title, description, and itemised line items — in one click.

---

## Features

### Invoice Management
- Create invoices with multiple line items, quantity, rate, and automatic total calculation
- Apply configurable tax rates per invoice
- Track invoice lifecycle: **Draft → Sent → Paid / Overdue**
- Quick status updates directly from the invoice detail view
- Auto-generated unique invoice numbers (e.g. `INV-849302`)
- Full edit and delete support

### Client Management
- Maintain a client directory with name, email, phone, company, and address
- Client data is scoped to the logged-in user — no data leakage between accounts
- Card-based UI with instant search and inline edit/delete

### Expense Tracking
- Log business expenses with title, amount, date, and category
- Seven categories: Tools, Marketing, Utilities, Travel, Food, Office, Other
- Filter by category and search by title
- Running total visible at all times

### Dashboard & Analytics
- **4 stats cards:** Total Revenue, Pending Amount, Overdue Amount, Total Expenses
- **6-month area chart** comparing revenue (paid invoices) vs. expenses month-by-month
- **Recent invoices** panel with direct navigation to each
- **Quick count tiles** for All / Paid / Sent / Overdue invoices

### AI Invoice Generation (Groq + Llama 3.3)
- Describe a project in plain English (e.g. *"Logo design for a bakery"*)
- One click calls the Groq API with the `llama-3.3-70b-versatile` model
- AI returns structured JSON: invoice title, professional description, and 2–4 suggested line items with realistic INR rates
- Results are pre-filled into the form — user reviews and submits

### Authentication & Security
- Email/password registration with bcrypt hashing (12 salt rounds)
- JWT issued on login, stored in an **httpOnly, SameSite=Lax cookie** — immune to XSS token theft
- 7-day token expiry
- Route-level auth guard (`proxy.ts`) redirects unauthenticated requests server-side
- All API routes verify the JWT before touching the database
- Every database query scopes by `userId` — users can never access each other's data
- Server-side input validation with Zod v4 on all POST/PUT endpoints

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Framework | Next.js 16 (App Router) | SSR, API routes, and UI in one project; no Express needed |
| Language | TypeScript 5 | End-to-end type safety from DB models to UI props |
| Database | MongoDB + Mongoose 8 | Flexible document model suits invoice/expense shapes well |
| Auth | JWT + httpOnly cookies | Stateless, secure, works without a session store |
| Styling | Tailwind CSS v4 | Utility-first; consistent design system, no CSS files |
| Charts | Recharts | Composable React chart components, minimal bundle cost |
| Forms | React Hook Form + Zod v4 | Uncontrolled forms for perf; Zod for runtime validation |
| AI | Groq + Llama 3.3 70B | Ultra-fast inference, free tier, structured JSON output |
| Icons | Lucide React | Tree-shakeable, consistent stroke style |
| Deployment | Vercel | Zero-config Next.js deployment with edge CDN |

---

## Project Structure

```
invoice-manager/
├── src/
│   ├── app/
│   │   ├── (auth)/                  # Public auth pages
│   │   │   ├── login/page.tsx
│   │   │   └── signup/page.tsx
│   │   ├── (dashboard)/             # Protected app shell
│   │   │   ├── layout.tsx           # Sidebar + auth check
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── invoices/
│   │   │   │   ├── page.tsx         # Invoice list
│   │   │   │   ├── new/page.tsx     # Create invoice
│   │   │   │   └── [id]/page.tsx    # Invoice detail + edit
│   │   │   ├── clients/page.tsx
│   │   │   └── expenses/page.tsx
│   │   ├── api/
│   │   │   ├── auth/                # register, login, logout, me
│   │   │   ├── invoices/            # CRUD + [id]
│   │   │   ├── clients/             # CRUD + [id]
│   │   │   ├── expenses/            # CRUD + [id]
│   │   │   ├── dashboard/stats/     # Aggregated stats
│   │   │   └── ai/suggest/          # Groq AI endpoint
│   │   ├── globals.css
│   │   ├── layout.tsx               # Root layout (Inter font, metadata)
│   │   └── page.tsx                 # Marketing landing page
│   ├── components/
│   │   ├── ui/                      # Button, Input, Select, Textarea, Badge, Modal
│   │   ├── layout/                  # Sidebar, Footer
│   │   ├── dashboard/               # StatsCard, RevenueChart
│   │   ├── invoices/                # InvoiceForm (with AI suggest)
│   │   ├── clients/                 # ClientForm
│   │   └── expenses/                # ExpenseForm
│   ├── lib/
│   │   ├── db.ts                    # Singleton MongoDB connection
│   │   ├── auth.ts                  # JWT sign/verify, cookie helpers
│   │   └── utils.ts                 # cn(), formatCurrency(), formatDate()
│   ├── models/
│   │   ├── User.ts                  # bcrypt pre-save hook, toJSON password strip
│   │   ├── Invoice.ts               # LineItem sub-schema, status enum
│   │   ├── Client.ts
│   │   └── Expense.ts               # Category enum
│   ├── types/
│   │   └── index.ts                 # Shared TS interfaces (IInvoice, IClient, etc.)
│   └── proxy.ts                     # Next.js 16 route guard (replaces middleware.ts)
├── .env.local.example
├── next.config.ts
├── tailwind.config (inline via PostCSS)
└── ARCHITECTURE.md
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- A MongoDB database (free tier on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas))
- A Groq API key (free at [console.groq.com](https://console.groq.com))

### 1. Clone and Install

```bash
git clone https://github.com/koyalmohadikar/invoice-manager.git
cd invoice-manager
npm install
```

### 2. Configure Environment

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/invoice-manager
JWT_SECRET=a-long-random-secret-string-change-this
GROQ_API_KEY=your-key-from-console.groq.com
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 3. Run the Dev Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — sign up for a new account and you're in.

### 4. Build for Production

```bash
npm run build
npm start
```

---

## Deployment

This project is configured for **zero-config Vercel deployment**:

1. Push to a GitHub repository
2. Import the repo at [vercel.com/new](https://vercel.com/new)
3. Add the four environment variables (`MONGODB_URI`, `JWT_SECRET`, `GROQ_API_KEY`, `NEXT_PUBLIC_APP_URL`) in Vercel project settings
4. Deploy — every push to `main` triggers an automatic redeploy (CI/CD)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Secret key for signing JWTs — use a long random string in production |
| `GROQ_API_KEY` | Yes | Groq API key — required for AI invoice generation |
| `NEXT_PUBLIC_APP_URL` | No | Base URL (used for metadata) |

---

## Security Considerations

- Passwords are hashed with **bcrypt (12 rounds)** before storage
- JWTs are stored in **httpOnly cookies** — not accessible from JavaScript
- All mutations validate and sanitise input with **Zod v4 schemas** server-side
- Database queries always filter by `userId` — enforcing **row-level isolation**
- `JWT_SECRET` and `MONGODB_URI` are server-only env vars (no `NEXT_PUBLIC_` prefix)
- The AI endpoint validates input length and returns a safe 503 if the API key is missing

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a detailed breakdown of the system design, data flow, and design decisions.

---

## Author

Built by **Koyal Mohadikar**

- GitHub: [github.com/koyalmohadikar](https://github.com/koyalmohadikar)
- LinkedIn: [linkedin.com/in/koyal-mohadikar](https://www.linkedin.com/in/koyal-mohadikar)
