/**
 * What the app would send the model for a venue, rebuilt from its snapshot:
 * the same pages, the same private-dining flag, the same ordering and the
 * same 12,000-character cut. PDF text is left out because the app does not
 * read PDFs (the student must see exactly what production sees).
 */
import { buildLlmInput } from "../../../src/lib/discovery/llm-extract";
import { signalsFromPages, type ScrapedPage } from "../../../src/lib/discovery/scraper";
import type { Snapshot } from "./snapshot-core";

export function studentPages(snapshot: Snapshot): ScrapedPage[] {
  return snapshot.pages
    .filter((p) => p.kind !== "pdf")
    .map((p) => ({ url: p.url, text: p.text, privateDining: p.kind === "private_dining" }));
}

export function studentInput(snapshot: Snapshot): {
  input: string;
  privateDiningPageFound: boolean;
  pages: ScrapedPage[];
} {
  const pages = studentPages(snapshot);
  const signals = signalsFromPages(pages, [], snapshot.website ?? "");
  return {
    input: buildLlmInput(signals.privateDiningText ?? "", signals.combinedText),
    privateDiningPageFound: signals.privateDiningPageFound,
    pages,
  };
}
