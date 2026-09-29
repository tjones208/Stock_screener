"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { STRATEGY_BY_KEY, strategyQuery } from "@/lib/strategies";

type Option = { key: string; name: string; style: string };

/** Choosing a strategy replaces the current filters with that strategy's preset. */
export function StrategyPicker({ current, options }: { current: string; options: Option[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const styles = [...new Set(options.map((o) => o.style))];

  function pick(key: string) {
    const s = STRATEGY_BY_KEY.get(key);
    startTransition(() => router.push(s ? `/?${strategyQuery(s)}` : "/"));
  }

  return (
    <label>
      Strategy{pending && <span className="muted"> · loading…</span>}
      <select value={current} disabled={pending} onChange={(e) => pick(e.target.value)}>
        <option value="">None: default filters</option>
        {styles.map((style) => (
          <optgroup key={style} label={style}>
            {options.filter((o) => o.style === style).map((o) => (
              <option key={o.key} value={o.key}>{o.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
