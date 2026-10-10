import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are an expert invoice assistant for Indian freelancers and small businesses.

When given a project description, generate professional invoice data and respond ONLY with a valid JSON object in this exact shape:
{
  "title": "short invoice title (5-8 words max)",
  "description": "professional 2-3 sentence description of the work done",
  "lineItems": [
    { "description": "service name", "quantity": 1, "rate": 15000 }
  ]
}

Rules:
- title: concise, professional (e.g. "Website Redesign – Phase 1", "Mobile App UI Design")
- description: formal project summary suitable for a client-facing invoice
- lineItems: 2–4 items that logically break down the project
- quantity: hours worked OR 1 for fixed-price deliverables
- rate: amount in Indian Rupees (₹) — use realistic Indian freelance market rates:
    UI/UX Design          ₹300–₹600/hr  or  ₹8,000–₹25,000 fixed
    Web Development       ₹400–₹700/hr  or  ₹15,000–₹80,000 fixed
    Mobile App Dev        ₹500–₹900/hr  or  ₹40,000–₹2,00,000 fixed
    Logo / Brand Design   ₹5,000–₹20,000 fixed
    Content Writing       ₹1,500–₹5,000 per article
    SEO Services          ₹8,000–₹25,000/month
    Social Media Mgmt     ₹8,000–₹20,000/month
    Video Editing         ₹3,000–₹15,000 fixed
    Photography           ₹5,000–₹25,000 fixed
    Consulting / Strategy ₹1,000–₹3,000/hr

Respond with ONLY the JSON object. No markdown, no code fences, no explanation.`;

export async function POST(req: NextRequest) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  let prompt: string;
  try {
    const body = await req.json();
    prompt = body.prompt;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return NextResponse.json({ success: false, error: 'Prompt is required (min 3 characters)' }, { status: 400 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ success: false, error: 'Groq API key not configured' }, { status: 503 });
  }

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `Generate invoice data for this project: ${prompt.trim()}` },
        ],
        temperature: 0.5,
        max_tokens: 700,
        response_format: { type: 'json_object' },
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('[groq] API error', groqRes.status, errText);
      throw new Error(`Groq returned ${groqRes.status}`);
    }

    const groqJson = await groqRes.json();
    const content  = groqJson.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from Groq');

    const parsed = JSON.parse(content) as {
      title?: string;
      description?: string;
      lineItems?: { description: string; quantity: number; rate: number }[];
    };

    if (!parsed.title || !Array.isArray(parsed.lineItems) || parsed.lineItems.length === 0) {
      throw new Error('Unexpected response structure from AI');
    }

    // Sanitise line items — ensure numbers are numbers
    parsed.lineItems = parsed.lineItems.map((li) => ({
      description: String(li.description ?? ''),
      quantity:    Number(li.quantity)    || 1,
      rate:        Number(li.rate)        || 0,
    }));

    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[groq] suggest error:', err);
    return NextResponse.json(
      { success: false, error: 'AI suggestion failed. Please try again.' },
      { status: 500 }
    );
  }
}
