// Strategy registry: add a strategy here to make it available to `bt run` / `bt sweep`.
import type { StrategyDef } from "../engine/engine.ts";
import { buyHold } from "./buyhold.ts";
import { smaTiming } from "./sma-timing.ts";
import { topN } from "./topn.ts";
import { momentum } from "./momentum.ts";

export const STRATEGIES: Record<string, StrategyDef> = Object.fromEntries(
  ([buyHold, smaTiming, topN, momentum] as unknown as StrategyDef[]).map((s) => [s.name, s]),
);
