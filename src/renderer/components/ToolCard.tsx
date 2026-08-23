import { useState } from "react";
import type { ToolItem } from "../types.ts";

/** Compact one-line summary of a tool's arguments, for the collapsed header. */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (typeof args["command"] === "string") return args["command"] as string;
  for (const k of ["path", "file_path", "query", "pattern", "url"]) {
    if (typeof args[k] === "string") return args[k] as string;
  }
  const keys = Object.keys(args);
  return keys.length ? `${keys.length} argument${keys.length > 1 ? "s" : ""}` : "";
}

export function ToolCard({ item }: { item: ToolItem }) {
  // Errors deserve attention; successful calls stay out of the way.
  const [open, setOpen] = useState(item.status === "error");

  return (
    <div className={`tool${item.status === "error" ? " err" : ""}`}>
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        {item.status === "running" ? <div className="spin" /> : null}
        <span className="tool-name">{item.name}</span>
        <span className="tool-arg">{summarizeArgs(item.name, item.args)}</span>
        <span className="tool-status">
          {item.status === "running" ? "running" : item.status === "error" ? "failed" : "done"}
        </span>
        <span className="tool-status">{open ? "▾" : "▸"}</span>
      </div>
      {open ? (
        <div className="tool-body">{item.output || "(no output)"}</div>
      ) : null}
    </div>
  );
}
