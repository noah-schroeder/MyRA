import { useState } from "react";
import type { ToolItem } from "../types.ts";
import type { Artifact } from "./ArtifactPanel.tsx";
import { DiagramThumbnail } from "./DiagramThumbnail.tsx";

/** Compact one-line summary of a tool's arguments, for the collapsed header. */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (typeof args["command"] === "string") return args["command"] as string;
  for (const k of ["path", "file_path", "query", "pattern", "url"]) {
    if (typeof args[k] === "string") return args[k] as string;
  }
  const keys = Object.keys(args);
  return keys.length ? `${keys.length} argument${keys.length > 1 ? "s" : ""}` : "";
}

/** The artifact `item.detail` points at, when the tool that produced this
 *  card is one the artifact panel also tracks -- looked up by shape rather
 *  than tool name, so a future diagram/chart-producing tool needs no list
 *  here to join. Absent for every other tool, and for a card rebuilt from a
 *  reopened conversation, where `detail` was never persisted. */
function artifactFor(item: ToolItem, artifacts: Artifact[]): Artifact | undefined {
  const detail = item.detail as { id?: unknown } | undefined;
  const id = typeof detail?.id === "string" ? detail.id : undefined;
  return id === undefined ? undefined : artifacts.find((a) => a.key === id);
}

export function ToolCard({
  item, artifacts, onOpenArtifact,
}: {
  item: ToolItem;
  /** Omitted, a card renders with no inline preview -- callers that do not
   *  track the artifact panel's items are unaffected. */
  artifacts?: Artifact[];
  onOpenArtifact?: (key: string) => void;
}) {
  // Errors deserve attention; successful calls stay out of the way.
  const [open, setOpen] = useState(item.status === "error");
  const artifact = artifacts ? artifactFor(item, artifacts) : undefined;

  return (
    <div className={`tool${item.status === "error" ? " err" : ""}`}>
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        {item.status === "running" ? <div className="spin" /> : null}
        <span className="tool-name">{item.name}</span>
        <span className="tool-arg">{summarizeArgs(item.name, item.args)}</span>
        <span className="tool-status">
          {item.status === "running"
            ? "running"
            : item.status === "error"
              ? "failed"
              : item.status === "stopped"
                ? "stopped"
                : "done"}
        </span>
        <span className="tool-status">{open ? "▾" : "▸"}</span>
      </div>
      {open ? (
        <div className="tool-body">{item.output || "(no output)"}</div>
      ) : null}
      {/* Always visible, independent of the collapse toggle above -- the
          thumbnail is the visual proxy for what the tool produced, not part
          of the raw text that toggle governs. */}
      {artifact?.kind === "diagram" && onOpenArtifact ? (
        <DiagramThumbnail diagram={artifact.diagram} onClick={() => onOpenArtifact(artifact.key)} />
      ) : null}
    </div>
  );
}
