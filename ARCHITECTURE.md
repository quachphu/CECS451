# FinFlow — Architecture Documentation

This document describes the system design, data flow, component boundaries, and key technical decisions behind FinFlow.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Request Lifecycle](#2-request-lifecycle)
3. [Authentication Architecture](#3-authentication-architecture)
4. [Database Design](#4-database-design)
5. [API Layer](#5-api-layer)
6. [Frontend Architecture](#6-frontend-architecture)
7. [AI Integration](#7-ai-integration)
8. [Data Flow Diagrams](#8-data-flow-diagrams)
9. [Security Model](#9-security-model)
10. [Key Design Decisions](#10-key-design-decisions)

---

## 1. High-Level Overview

FinFlow is a **monolithic full-stack application** built entirely within Next.js 16. There is no separate backend service — the API routes, server components, and static pages all live in the same codebase and deploy to Vercel as a single unit.

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser / Client                     │
│                                                             │
│   Landing Page   Login / Signup   Dashboard (SPA shell)     │
└──────────────────────────┬──────────────────────────────────┘
                           │  HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Next.js 16 (Vercel)                     │
│                                                             │
│  ┌─────────────────────┐   ┌──────────────────────────────┐ │
│  │    proxy.ts         │   │   App Router Pages           │ │
│  │  (Route Guard)      │   │   Server + Client Components │ │
│  └──────────┬──────────┘   └──────────────┬───────────────┘ │
│             │                             │                 │
│             ▼                             ▼                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │               API Route Handlers (/api/*)               ││
│  │   auth • invoices • clients • expenses • dashboard • ai ││
│  └──────────────────────────┬──────────────────────────────┘│
└─────────────────────────────┼───────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────────┐
        │ MongoDB  │   │  bcrypt  │   │  Gemini API  │
        │  Atlas   │   │  (local) │   │  (Google AI) │
        └──────────┘   └──────────┘   └──────────────┘
```

---

## 2. Request Lifecycle

### Unauthenticated page request (e.g. `/dashboard`)

```
Browser → GET /dashboard
  → proxy.ts runs (Next.js 16 route middleware)
      → reads auth_token cookie
      → verifyToken() returns null (no token)
      → NextResponse.redirect('/login')
  → Browser lands on /login
```

### Authenticated page request (e.g. `/invoices`)

```
Browser → GET /invoices
  → proxy.ts runs
      → reads auth_token cookie
      → verifyToken() returns { userId, email, name }
      → NextResponse.next()
  → (dashboard)/layout.tsx renders (Server Component)
      → getAuthUser() re-verifies token
      → renders <Sidebar> + <Footer> + {children}
  → invoices/page.tsx renders as Client Component
      → useEffect → fetch('/api/invoices')
      → displays invoice list
```

### API request (e.g. `POST /api/invoices`)

```
Client → POST /api/invoices  { ...invoiceData }
  → route.ts handler
      → getAuthUser() reads cookie from request headers
      → verifyToken() → { userId } or null
      → if null → 401 Unauthorized
      → ZodSchema.safeParse(body) → validation
      → if invalid → 400 with first error message
      → connectDB() → reuse or create Mongoose connection
      → Invoice.create({ ...data, userId }) → saved to MongoDB
      → return 201 { success: true, data: invoice }
```

---

## 3. Authentication Architecture

### Token Flow

```
1. User submits login form
         │
         ▼
2. POST /api/auth/login
   - Find user by email in MongoDB
   - bcrypt.compare(password, user.password)
   - If valid: jwt.sign({ userId, email, name }, JWT_SECRET, { expiresIn: '7d' })
         │
         ▼
3. Set-Cookie: auth_token=<jwt>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800
         │
         ▼
4. Browser stores cookie automatically
   (NOT in localStorage — protected from XSS)
         │
         ▼
5. Every subsequent request automatically sends the cookie
         │
         ▼
6. API routes call getAuthUser() → cookies() → verifyToken() → JwtPayload | null
```

### Why httpOnly cookies over localStorage

| | localStorage | httpOnly Cookie |
|--|--|--|
| XSS access | Readable by any script | **Inaccessible to JavaScript** |
| CSRF risk | None | Low (SameSite=Lax mitigates) |
| Expiry control | Manual | Automatic via Max-Age |
| Server reads | Extra header needed | **Automatic with every request** |

### Proxy (Route Guard)

`src/proxy.ts` runs on the **Edge runtime** before any page renders. It reads the cookie, verifies the JWT, and either lets the request through or redirects — without hitting the database. This is an **optimistic check**: full authorisation still happens in each API route handler.

```
Protected paths:  /dashboard, /invoices, /clients, /expenses
Public auth pages: /login, /signup

Rule 1: Unauthenticated user on protected path → redirect /login
Rule 2: Authenticated user on /login or /signup → redirect /dashboard
Rule 3: Everything else → pass through
```

---

## 4. Database Design

### Collections

#### `users`

```
{
  _id: ObjectId,
  name: String (required, max 100),
  email: String (required, unique, lowercase),
  password: String (bcrypt hash, never returned in JSON),
  createdAt: Date,
  updatedAt: Date
}
```

The `toJSON` transform strips `password` from all serialisations. The `pre('save')` async hook hashes the password only when it is modified — preventing double-hashing on unrelated updates.

#### `clients`

```
{
  _id: ObjectId,
  userId: ObjectId (ref: User, indexed),
  name: String (required),
  email: String (required),
  phone: String?,
  address: String?,
  company: String?,
  createdAt: Date
}
```

`userId` is indexed for fast per-user queries. All client API queries filter `{ userId: auth.userId }` — a user can never see another user's clients.

#### `invoices`

```
{
  _id: ObjectId,
  userId: ObjectId (ref: User, indexed),
  clientId: ObjectId (ref: Client),
  invoiceNumber: String (unique, auto-generated),
  title: String,
  description: String?,
  lineItems: [{
    description: String,
    quantity: Number,
    rate: Number,
    amount: Number  ← always server-computed (quantity × rate)
  }],
  subtotal: Number,   ← server-computed
  taxRate: Number,
  tax: Number,        ← server-computed
  total: Number,      ← server-computed
  status: 'draft' | 'sent' | 'paid' | 'overdue',
  dueDate: Date,
  notes: String?,
  createdAt: Date,
  updatedAt: Date
}
```

**Important:** `subtotal`, `tax`, `total`, and `amount` per line item are **always recalculated server-side** on create and update. The client sends quantities and rates; the server computes all derived monetary values. This prevents any client-side manipulation of invoice totals.

#### `expenses`

```
{
  _id: ObjectId,
  userId: ObjectId (ref: User, indexed),
  title: String,
  amount: Number,
  category: 'Tools' | 'Marketing' | 'Utilities' | 'Travel' | 'Food' | 'Office' | 'Other',
  date: Date,
  notes: String?,
  createdAt: Date
}
```

### Relationships

```
User (1) ──< Client (many)
User (1) ──< Invoice (many)
User (1) ──< Expense (many)
Client (1) ──< Invoice (many)   [soft reference via clientId]
```

Invoices store a `clientId` reference. When fetched, the API populates client fields (`name`, `email`, `company`) using Mongoose's `.populate()`. Deleting a client does **not** cascade-delete invoices by design — historical records are preserved.

### MongoDB Connection Strategy

```typescript
// lib/db.ts — module-level singleton
const cached = { conn: null, promise: null };

export async function connectDB() {
  if (cached.conn) return cached.conn;   // reuse on hot reload
  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, { bufferCommands: false });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
```

In serverless environments (Vercel), each function invocation may reuse a warm container. The module-level cache means the existing Mongoose connection is reused instead of opening a new one on every request — a critical performance optimisation for serverless MongoDB.

---

## 5. API Layer

All API routes live under `src/app/api/` and follow Next.js 16 Route Handler conventions.

### Endpoint Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Create account, set JWT cookie |
| POST | `/api/auth/login` | No | Verify credentials, set JWT cookie |
| POST | `/api/auth/logout` | No | Clear JWT cookie |
| GET | `/api/auth/me` | Yes | Return current user |
| GET | `/api/invoices` | Yes | List invoices (filterable by status, clientId) |
| POST | `/api/invoices` | Yes | Create invoice |
| GET | `/api/invoices/[id]` | Yes | Get single invoice (populated client) |
| PUT | `/api/invoices/[id]` | Yes | Update invoice |
| DELETE | `/api/invoices/[id]` | Yes | Delete invoice |
| GET | `/api/clients` | Yes | List clients |
| POST | `/api/clients` | Yes | Create client |
| GET | `/api/clients/[id]` | Yes | Get client |
| PUT | `/api/clients/[id]` | Yes | Update client |
| DELETE | `/api/clients/[id]` | Yes | Delete client |
| GET | `/api/expenses` | Yes | List expenses (filterable by category) |
| POST | `/api/expenses` | Yes | Create expense |
| PUT | `/api/expenses/[id]` | Yes | Update expense |
| DELETE | `/api/expenses/[id]` | Yes | Delete expense |
| GET | `/api/dashboard/stats` | Yes | Aggregated revenue, expense, and chart data |
| POST | `/api/ai/suggest` | Yes | Gemini AI invoice suggestion |

### Request Validation Pattern

Every mutating endpoint follows this pattern:

```typescript
// 1. Auth check — always first
const auth = await getAuthUser();
if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

// 2. Parse + validate with Zod
const parsed = Schema.safeParse(await req.json());
if (!parsed.success) {
  return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
}

// 3. Connect to DB and execute query scoped to userId
await connectDB();
const result = await Model.create({ ...parsed.data, userId: auth.userId });
```

### Dashboard Stats Aggregation

The `/api/dashboard/stats` route fetches all invoices and expenses for the user in **two parallel queries** using `Promise.all`, then computes all stats in-memory:

```typescript
const [invoices, expenses] = await Promise.all([
  Invoice.find({ userId }),
  Expense.find({ userId }),
]);
```

Monthly chart data is computed by iterating over the last 6 months and filtering by date range — no MongoDB aggregation pipeline needed at this data scale.

---

## 6. Frontend Architecture

### Rendering Strategy

| Page | Rendering | Reason |
|------|-----------|--------|
| `/` (Landing) | Static (SSG) | No dynamic data |
| `/login`, `/signup` | Static (SSG) | No dynamic data |
| `/dashboard` | Client (CSR) | Fetches user-specific stats on mount |
| `/invoices` | Client (CSR) | Filterable, searchable list |
| `/invoices/[id]` | Client (CSR) | Loads invoice + client on mount |
| `/invoices/new` | Client (CSR) | Form with AI integration |
| `/clients` | Client (CSR) | Interactive card grid |
| `/expenses` | Client (CSR) | Filterable table |
| `(dashboard)/layout.tsx` | Server Component | Auth check + Sidebar |

The dashboard shell (`layout.tsx`) is a **Server Component** that reads the auth cookie and verifies the JWT server-side before rendering anything. If the user is unauthenticated, it redirects immediately — no flash of protected content.

All dashboard *pages* are **Client Components** (`'use client'`) because they need `useEffect`, `useState`, and event handlers for interactivity.

### Component Hierarchy

```
RootLayout (Server)
├── LandingPage (Server — static)
├── LoginPage (Client)
├── SignupPage (Client)
└── DashboardLayout (Server — auth check)
    ├── Sidebar (Client — navigation state)
    ├── Footer (Server)
    └── [page] (Client)
        ├── UI Primitives (Button, Input, Select, Textarea, Badge, Modal)
        └── Feature Components (InvoiceForm, ClientForm, ExpenseForm, etc.)
```

### Form Architecture

Forms use **React Hook Form** with uncontrolled inputs for performance (no re-render per keystroke) and **Zod v4** schemas for validation. The resolver used is `standardSchemaResolver` from `@hookform/resolvers/standard-schema` — compatible with Zod v4's Standard Schema interface.

Number fields (`amount`, `quantity`, `rate`) use the HTML `valueAsNumber: true` registration option so the form receives native JavaScript numbers, avoiding coercion type issues.

### State Management

No external state library (Redux, Zustand) is used. State is managed at the **page level** with `useState`:

- `invoices`, `clients`, `expenses` arrays are fetched on mount and updated optimistically on create/delete
- Modals are controlled by `open: boolean` state
- Edit state is `editItem: T | null`

This is sufficient for a single-user dashboard where data changes are always the result of the current user's own actions.

---

## 7. AI Integration

### Flow

```
User types: "Logo design and brand kit for a coffee shop"
    │
    ▼
POST /api/ai/suggest  { prompt: "..." }
    │
    ▼
Server validates: auth check + prompt length check
    │
    ▼
GoogleGenerativeAI('gemini-1.5-flash').generateContent(systemPrompt)
    │
    ▼
Gemini returns text containing JSON:
{
  "title": "Brand Identity Design for Coffee Shop",
  "description": "Complete brand identity package including logo design...",
  "lineItems": [
    { "description": "Logo Design (3 concepts)", "quantity": 1, "rate": 15000 },
    { "description": "Brand Style Guide", "quantity": 1, "rate": 8000 },
    { "description": "Business Card Design", "quantity": 1, "rate": 3500 }
  ]
}
    │
    ▼
Server extracts JSON with regex: text.match(/\{[\s\S]*\}/)
    │
    ▼
Returns structured data to client
    │
    ▼
InvoiceForm pre-fills: title, description, lineItems via setValue()
```

### System Prompt Design

The AI is given a precise JSON schema to follow and instructed to respond with **only valid JSON** — no markdown, no prose. The server extracts the JSON block with a regex before parsing, making it robust to any extra text the model occasionally outputs.

### Graceful Degradation

If `GEMINI_API_KEY` is not set or is the placeholder value, the endpoint returns `503 Service Unavailable` with a clear error message. The "Suggest with AI" button remains visible but shows the error inline — the rest of the invoice form works normally.

---

## 8. Data Flow Diagrams

### Creating an Invoice

```
User fills form → clicks "Create Invoice"
        │
        ▼
InvoiceForm: handleSubmit(data: FormData)
        │
        ▼
POST /api/invoices
  Body: { clientId, title, lineItems: [{description, quantity, rate}], taxRate, dueDate, ... }
        │
        ▼
API Route:
  1. Verify JWT cookie → userId
  2. Zod validate body
  3. Server recomputes: amount = qty × rate, subtotal, tax, total
  4. Invoice.create({ ...data, userId, invoiceNumber: generateInvoiceNumber() })
  5. populate('clientId', 'name email company')
  6. Return 201 { success: true, data: invoice }
        │
        ▼
Client: router.push('/invoices/' + invoice._id)
```

### Dashboard Stats Calculation

```
GET /api/dashboard/stats
        │
        ▼
Promise.all([Invoice.find({userId}), Expense.find({userId})])
        │
        ▼
In-memory computation:
  totalRevenue   = invoices.filter(paid).sum(total)
  pendingAmount  = invoices.filter(sent).sum(total)
  overdueAmount  = invoices.filter(overdue).sum(total)
  totalExpenses  = expenses.sum(amount)
        │
        ▼
Monthly chart (last 6 months):
  For each month M (current-5 to current):
    revenue[M]  = paid invoices where updatedAt in [startOf(M), endOf(M)].sum(total)
    expenses[M] = expenses where date in [startOf(M), endOf(M)].sum(amount)
        │
        ▼
Return all stats + recentInvoices (latest 5) + monthlyRevenue[]
```

---

## 9. Security Model

### Threat Mitigations

| Threat | Mitigation |
|--------|-----------|
| Password theft | bcrypt hash with 12 rounds — brute-force resistant |
| XSS token theft | JWT in httpOnly cookie — JS cannot read it |
| CSRF | SameSite=Lax cookie policy — cross-origin forms cannot send the cookie |
| Horizontal privilege escalation | Every DB query filters `{ userId: auth.userId }` |
| Mass assignment / injection | Zod schemas whitelist only known fields; Mongoose sanitises queries |
| Brute-force login | Generic "Invalid email or password" response — no user enumeration |
| AI prompt injection | Input is validated for length; AI response is regex-extracted, then JSON.parsed — raw AI text never executes |
| Secrets exposure | `JWT_SECRET`, `MONGODB_URI`, `GEMINI_API_KEY` are server-only env vars (no `NEXT_PUBLIC_` prefix) |

### What Is NOT Implemented (Scope Exclusions)

- Rate limiting (would add with Upstash Redis in production)
- Email verification on signup
- Password reset flow
- Audit logs
- HTTPS enforcement (handled by Vercel/CDN layer)

---

## 10. Key Design Decisions

### Why a monolith, not microservices?

At this scale (single-user SaaS prototype), a monolith is the right choice. It is simpler to develop, deploy, and reason about. Next.js App Router makes the separation between frontend and backend clean enough within a single codebase.

### Why MongoDB over PostgreSQL?

Invoice documents are naturally hierarchical (an invoice contains an array of line items). Storing them as embedded documents in MongoDB is simpler than normalising them into a relational schema with a separate `line_items` table and JOIN queries. The schema is also flexible — adding new invoice fields doesn't require migrations.

### Why no Redux / Zustand?

The app has no shared state that needs to be accessed by components far apart in the tree. All state is local to a page. Adding a state management library would be premature complexity.

### Why server-recompute invoice totals?

Client-sent `amount`, `subtotal`, and `total` values are ignored. The server always recomputes them from `quantity × rate`. This prevents a malicious user from crafting a POST request with `total: 1` to create a ₹1 invoice that should be ₹100,000. Financial data must always be authoritative on the server.

### Why `standardSchemaResolver` instead of `zodResolver`?

Zod v4 ships with a significant type system rewrite. The traditional `zodResolver` from `@hookform/resolvers/zod` has input/output type conflicts with Zod v4's coercion types. Zod v4 implements the **Standard Schema** spec — using `standardSchemaResolver` resolves the type mismatch cleanly.

### Why `proxy.ts` instead of `middleware.ts`?

Next.js 16 renamed `middleware.ts` to `proxy.ts` and the exported function from `middleware` to `proxy`. The rename better reflects the file's actual purpose — it proxies requests, potentially redirecting them, rather than sitting in the middle of a pipeline.

---

*Architecture documented for FinFlow v1.0 — Jan 2026*
