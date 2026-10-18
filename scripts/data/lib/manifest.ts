/**
 * Run manifest: every script appends one line to eval/run_manifest.jsonl with
 * what it ran on, what it produced, which models it called and what it spent,
 * so each result can be traced to its inputs.
 */
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { evalDir, sha256File } from "./io";

export type ManifestEntry = {
  script: string;
  git_sha: string | null;
  started_at: string;
  ended_at: string;
  models: Record<string, string>;
  counts: Record<string, number>;
  spend: Record<string, number>;
  inputs: Record<string, string | null>;
  outputs: Record<string, string | null>;
  status: "ok" | "aborted_budget" | "aborted_error" | "partial";
  notes?: string;
};

export function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export class RunManifest {
  private readonly startedAt = new Date().toISOString();
  models: Record<string, string> = {};
  counts: Record<string, number> = {};
  spend: Record<string, number> = {};
  inputs: string[] = [];
  outputs: string[] = [];
  notes?: string;

  constructor(private readonly script: string) {}

  count(key: string, by = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + by;
  }

  write(status: ManifestEntry["status"] = "ok"): ManifestEntry {
    const hash = (files: string[]) =>
      Object.fromEntries(files.map((f) => [f, sha256File(f)]));
    const entry: ManifestEntry = {
      script: this.script,
      git_sha: gitSha(),
      started_at: this.startedAt,
      ended_at: new Date().toISOString(),
      models: this.models,
      counts: this.counts,
      spend: this.spend,
      inputs: hash(this.inputs),
      outputs: hash(this.outputs),
      status,
      ...(this.notes ? { notes: this.notes } : {}),
    };
    const file = evalDir("run_manifest.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return entry;
  }
}
