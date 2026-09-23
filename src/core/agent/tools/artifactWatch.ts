/**
 * The draw-counter and watcher shapes diagram.ts, table.ts and chart.ts each
 * repeated on their own -- one factory here instead of three independent
 * copies that had already drifted (diagram.ts named its counter's accessor
 * `nextDiagramId`; table.ts and chart.ts inlined `++drawn` at the call site
 * instead).
 */

/**
 * A named, resettable sequence: "prefix-1", "prefix-2", ...
 *
 * Reset takes an optional starting point rather than always going back to
 * zero, so a conversation whose earlier figures were just replayed can
 * continue the sequence past them instead of relabelling the first one.
 */
export function makeIdCounter(prefix: string): { next(): string; reset(from?: number): void } {
  let drawn = 0;
  return {
    next: () => `${prefix}-${++drawn}`,
    reset: (from = 0) => {
      drawn = from;
    },
  };
}

/**
 * A single callback slot.
 *
 * Left uninstalled, an announcement tells nobody -- the right behaviour for
 * the test suite and for a headless run.
 */
export function makeWatcher<T>(): {
  set(fn: ((value: T) => void) | undefined): void;
  announce(value: T): void;
} {
  let watcher: ((value: T) => void) | undefined;
  return {
    set: (fn) => {
      watcher = fn;
    },
    announce: (value) => {
      watcher?.(value);
    },
  };
}

/**
 * The highest "prefix-N" suffix among a set of ids, or 0 if none match.
 *
 * What a reopened conversation seeds its counter to, so the next figure it
 * draws continues the sequence instead of relabelling one already shown.
 */
export function maxDrawnId(prefix: string, ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(`${prefix}-`)) continue;
    const n = Number(id.slice(prefix.length + 1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
