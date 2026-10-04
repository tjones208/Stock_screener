// Strategy library: the built-in strategies plus every file in backtest/strategies/ (drop-in
// strategies: one .ts file each, exporting a StrategyDef as default or as any named export).
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { StrategyDef } from "../engine/engine.ts";
import { buyHold } from "./buyhold.ts";
import { smaTiming } from "./sma-timing.ts";
import { topN } from "./topn.ts";
import { momentum } from "./momentum.ts";

export const BUILT_IN: StrategyDef[] = [buyHold, smaTiming, topN, momentum] as unknown as StrategyDef[];
export const STRATEGIES: Record<string, StrategyDef> = Object.fromEntries(BUILT_IN.map((s) => [s.name, s]));

/** Folder for your own strategy files. */
export const USER_STRATEGY_DIR = resolve(import.meta.dirname, "..", "..", "strategies");

const isDef = (x: unknown): x is StrategyDef =>
  !!x && typeof x === "object" && typeof (x as StrategyDef).name === "string" && typeof (x as StrategyDef).create === "function";

/**
 * Built-ins plus drop-in files. A broken file is reported, not fatal. Drop-ins are added to
 * STRATEGIES so every runner sees them; a drop-in with a built-in's name replaces it.
 */
export async function loadStrategies(dir = USER_STRATEGY_DIR) {
  const errors: { file: string; error: string }[] = [];
  const sources: Record<string, string> = Object.fromEntries(BUILT_IN.map((s) => [s.name, "built-in"]));
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => /\.(ts|js|mjs)$/.test(x) && !x.endsWith(".test.ts")).sort()) {
      try {
        const mod = (await import(pathToFileURL(join(dir, f)).href)) as Record<string, unknown>;
        const defs = Object.values(mod).filter(isDef);
        if (!defs.length) throw new Error("no exported strategy (an object with name and create)");
        for (const d of defs) { STRATEGIES[d.name] = d; sources[d.name] = f; }
      } catch (e) {
        errors.push({ file: f, error: String(e instanceof Error ? e.message : e).slice(0, 500) });
      }
    }
  }
  return { strategies: STRATEGIES, sources, errors };
}
