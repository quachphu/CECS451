/**
 * Loads keys for the training scripts from the process environment, falling
 * back to .env.local, and reports which ones are missing without printing any
 * value.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

export function requireEnv(...names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. Set them in the environment or .env.local.`);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]!.trim()]));
}
