/** Minimal RFC 4180 CSV reader (quoted fields, "" escapes, embedded commas/newlines). No dependency. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

export type LabelRow = {
  venue_key: string;
  city: string;
  category: string;
  url: string;
  hosts_private_events: boolean;
  room_name: string;
  max_capacity: number | null;
  min_capacity: number | null;
  min_spend_usd: number | null;
  evidence_quote: string;
  labeler: string;
};

const num = (s: string | undefined) => (s && s.trim() !== "" && !Number.isNaN(Number(s)) ? Number(s) : null);

/** Reads eval/labels.csv (columns: see eval/labels.template.csv). */
export function parseLabels(text: string): LabelRow[] {
  return parseCsv(text).map((r) => ({
    venue_key: r.venue_key,
    city: r.city ?? "",
    category: r.category ?? "",
    url: r.url ?? "",
    hosts_private_events: r.hosts_private_events === "1",
    room_name: r.room_name ?? "",
    max_capacity: num(r.max_capacity),
    min_capacity: num(r.min_capacity),
    min_spend_usd: num(r.min_spend_usd),
    evidence_quote: r.evidence_quote ?? "",
    labeler: r.labeler ?? "",
  }));
}
