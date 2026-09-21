/**
 * The bar `.cfg-*` in styles.css was written for, back when MyRA built the
 * launch command itself. That component and its producer were deleted in
 * "Hand the whole inference stack to Lemonade" -- the daemon launches models
 * now -- but the CSS survived with nothing drawing it, because the rule it
 * encodes did not stop being true: a configuration that does not fit has to
 * run visibly past the end of the bar rather than rescale to look like one
 * that does, or a person reads a red-flagged config as a green one.
 *
 * Its replacement input is `MemoryBudget` from `core/runtime/fit.ts`, a thin
 * projection over the same `fitModel` a load is sized by -- so this bar and
 * the number a model actually loads with cannot disagree, which is the exact
 * failure ("the panel showed 8192, the process launched with `-c 0`") the
 * comment above the CSS names.
 */

import { gb } from "./modelBits.tsx";
import type { MemoryBudget } from "../../core/runtime/fit.ts";

export function MemoryBar({
  budget,
  compact,
  against,
}: {
  budget: MemoryBudget;
  /** Bar only, no legend -- for the chat bar's dropdown, not the tuning panel. */
  compact?: boolean;
  /** What `budgetBytes` IS, when the caller can say it better than a figure
      can -- "your graphics card" rather than "the 8.0 GB available". Callers
      that have nothing better to say leave this out. */
  against?: string;
}) {
  /* `budgetBytes` is 0 before `lemonadeInfo()` has answered -- every caller's
     `Machine` starts as `{ ramBytes: 0 }`, which is indistinguishable here
     from a real machine with none. Dividing by it below would draw every
     segment at "Infinity%" (invalid CSS, silently dropped) and a negative
     headroom would flag a model that is loaded and running fine as not
     fitting. Nothing to draw yet is the honest answer, not a red bar. */
  if (budget.budgetBytes <= 0) return null;

  const over = budget.headroomBytes < 0;
  /* A percentage of the BUDGET, not of the total needed -- the rule the CSS
     comment states. A configuration using 140% of the budget draws a bar that
     is 140% full and visibly overruns its own track, rather than one that
     rescales its three segments to sum to 100% and looks identical to a
     config that fits with room to spare. */
  const pct = (n: number): string => `${Math.max(0, (n / budget.budgetBytes) * 100)}%`;

  const barClass = ["cfg-bar", over && "over", compact && "compact"].filter(Boolean).join(" ");
  const bar = (
    <div className={barClass}>
      <span className="seg-weights" style={{ width: pct(budget.weightsBytes) }} title="Model weights" />
      <span className="seg-cache" style={{ width: pct(budget.cacheBytes) }} title="Context cache (KV)" />
      <span className="seg-over" style={{ width: pct(budget.overheadBytes) }} title="Working memory" />
    </div>
  );

  if (compact) return bar;

  const availbadge = against ?? `the ${gb(budget.budgetBytes)} available`;
  return (
    <div className="cfg-budget">
      {bar}
      <ul className="cfg-key">
        <li>
          <i className="k-weights" />
          Weights {gb(budget.weightsBytes)}
        </li>
        <li>
          <i className="k-cache" />
          Context cache {gb(budget.cacheBytes)}
          {budget.estimated ? " (estimated)" : ""}
        </li>
        <li>
          <i className="k-over" />
          Working memory {gb(budget.overheadBytes)}
        </li>
        <li className={over ? "cfg-headroom over" : "cfg-headroom"}>
          {over
            ? `${gb(-budget.headroomBytes)} over ${availbadge}`
            : `${gb(budget.headroomBytes)} spare of ${gb(budget.budgetBytes)}`}
        </li>
      </ul>
    </div>
  );
}
