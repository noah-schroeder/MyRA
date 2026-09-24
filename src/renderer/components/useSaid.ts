import { useEffect, useRef, useState } from "react";

/**
 * A transient confirmation message that clears itself after a delay --
 * "Saved to Documents", "Copied", "Figure copied" -- shared by ChartView,
 * DiagramView and TableView, all three of which say something like this
 * after an export or copy action.
 *
 * Mirrors CopyButton's own timer ref, for the reason CopyButton's own
 * comment gives: cleared before scheduling a new one, so a second action's
 * confirmation is never erased early by the first one's already-pending
 * timer, and on unmount, so a component unmounted while the tick is pending
 * -- a tab closed, the artifact panel replaced -- does not come back to set
 * state on nothing.
 */
export function useSaid(ms = 2600): [string | undefined, (text: string) => void] {
  const [said, setSaid] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const say = (text: string): void => {
    setSaid(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(undefined), ms);
  };

  return [said, say];
}
