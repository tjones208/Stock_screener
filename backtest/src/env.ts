// Settings for the local tools: backtest/.env (gitignored) for MASSIVE_API_KEY, and
// backtest/app-settings.json (gitignored) for the app's folder choices.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const BT_ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = join(BT_ROOT, ".env");

/** Load KEY=value lines from backtest/.env into process.env (existing variables win). */
export function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** Save one variable to backtest/.env (replacing an existing line). */
export function saveEnv(key: string, value: string) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith(`${key}=`)) : [];
  lines.push(`${key}=${value}`);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");
  process.env[key] = value;
}
