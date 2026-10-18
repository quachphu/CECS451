/**
 * Hard spend caps. Each paid service has a ledger in eval/.spend/<service>.json
 * shared by every script and every run, so a cap holds across restarts. A
 * call is refused before it is made when it could push the total past the cap;
 * the script then saves its progress and exits cleanly.
 */
import { existsSync, readFileSync } from "node:fs";
import { evalDir, writeJsonAtomic } from "./io";

export class BudgetExceededError extends Error {
  constructor(
    readonly service: string,
    readonly spent: number,
    readonly cap: number
  ) {
    super(`${service} budget reached: ${spent.toFixed(4)} of ${cap} spent`);
    this.name = "BudgetExceededError";
  }
}

type Ledger = { service: string; unit: string; cap: number; spent: number; calls: number; updated_at: string };

export class Budget {
  private ledger: Ledger;
  private readonly file: string;

  constructor(
    readonly service: string,
    readonly unit: "usd" | "credits" | "calls",
    cap: number
  ) {
    this.file = evalDir(".spend", `${service}.json`);
    const saved = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Ledger) : null;
    this.ledger = { service, unit, cap, spent: saved?.spent ?? 0, calls: saved?.calls ?? 0, updated_at: "" };
  }

  get spent(): number {
    return this.ledger.spent;
  }

  get cap(): number {
    return this.ledger.cap;
  }

  get remaining(): number {
    return Math.max(0, this.ledger.cap - this.ledger.spent);
  }

  /** Throws before a call whose worst-case cost would cross the cap. */
  reserve(worstCase: number): void {
    if (this.ledger.spent + worstCase > this.ledger.cap) {
      throw new BudgetExceededError(this.service, this.ledger.spent, this.ledger.cap);
    }
  }

  /** Records what a call actually cost, and persists the ledger. */
  charge(amount: number): void {
    this.ledger.spent += amount;
    this.ledger.calls += 1;
    this.ledger.updated_at = new Date().toISOString();
    writeJsonAtomic(this.file, this.ledger);
  }
}

/** Token prices, read from config (env) so a price change needs no code change. */
export function tokenPrice(envName: string, fallbackPerMillion: number): number {
  const raw = process.env[envName];
  const value = raw != null && raw.trim() !== "" ? Number(raw) : fallbackPerMillion;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${envName} must be a non-negative number`);
  return value / 1_000_000;
}
