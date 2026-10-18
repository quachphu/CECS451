/**
 * File helpers for the training scripts: atomic writes, JSONL, CSV, hashing,
 * the eval/ directory, and the fixed random seed.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Where eval/ lives; TRAINING_EVAL_DIR points a dry run at a scratch folder. */
export function evalDir(...parts: string[]): string {
  return path.join(process.env.TRAINING_EVAL_DIR?.trim() || "eval", ...parts);
}

export const SEED = 451;

/** Writes to a temp file in the same folder, then renames, so a crash never leaves half a file. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function writeJsonlAtomic(file: string, rows: unknown[]): void {
  writeFileAtomic(
    file,
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(file: string): string | null {
  return existsSync(file) ? sha256(readFileSync(file)) : null;
}

// ------------------------------------------------------------------- CSV

/** RFC 4180 reader: quoted fields, "" escapes, embedded commas and newlines. */
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
  return body.map((r) =>
    Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])),
  );
}

export function readCsv(file: string): Record<string, string>[] {
  return existsSync(file)
    ? parseCsv(readFileSync(file, "utf8").replace(/^﻿/, ""))
    : [];
}

function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  columns: readonly string[],
  rows: Array<Record<string, unknown>>,
): string {
  return (
    [
      columns.join(","),
      ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")),
    ].join("\n") + "\n"
  );
}

export function writeCsvAtomic(
  file: string,
  columns: readonly string[],
  rows: Array<Record<string, unknown>>,
): void {
  writeFileAtomic(file, toCsv(columns, rows));
}

// ------------------------------------------------------------- randomness

/** mulberry32: a small seeded PRNG, so every sample is reproducible from SEED. */
export function seededRandom(seed = SEED): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with the seeded PRNG; returns a new array. */
export function seededShuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "--name value" / "--flag" command-line options. */
export function cliArgs(argv = process.argv.slice(2)): {
  flags: Set<string>;
  values: Map<string, string>;
} {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) values.set(key, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--"))
      values.set(key, argv[++i]);
    else flags.add(key);
  }
  return { flags, values };
}
