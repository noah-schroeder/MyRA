import { useEffect, useState } from "react";
import type { RuntimeState, Settings } from "../types.ts";

/**
 * Which model is answering, always visible.
 *
 * Until now nothing on screen said. Karen would happily talk to a model served
 * from this machine, a box on the LAN or a hosted API, and the only way to find
 * out which was to open Settings — so "why is this slow" and "why does this
 * sound different today" had no answer you could see.
 *
 * It doubles as the way in to the runtime. A local model is otherwise
 * discoverable only by opening Settings and finding a tab, which means someone
 * who never opens Settings never learns the feature exists.
 */

function shorten(model: string): string {
  // Repository paths and quantisation suffixes are most of the length and
  // least of the meaning: unsloth/Qwen3-Coder-30B-…-GGUF is "Qwen3-Coder-30B".
  const base = model.slice(model.lastIndexOf("/") + 1).replace(/\.gguf$/i, "");
  return base.replace(/-(GGUF|(?:IQ|TQ|Q)\d+[\w.]*|BF16|F16|F32)$/i, "");
}

export function ModelBar({ settings, onOpen }: { settings: Settings | undefined; onOpen: () => void }) {
  const [runtime, setRuntime] = useState<RuntimeState | undefined>();

  useEffect(() => {
    void window.karen.runtimeState().then(setRuntime);
    return window.karen.onRuntime(setRuntime);
  }, []);

  const server = runtime?.server;
  const local = runtime?.config.useForChat && server?.state === "ready";
  const loading = runtime?.config.useForChat && server?.state === "starting";

  let label: string;
  let tone: "local" | "remote" | "loading" | "none";

  if (loading) {
    label = "Loading the model…";
    tone = "loading";
  } else if (local && runtime?.config.activeModel) {
    label = shorten(runtime.config.activeModel);
    tone = "local";
  } else if (settings?.llm.baseUrl) {
    // Someone else's server. Name the model when one is pinned, the host when
    // it is not — "(server default)" is true and tells you nothing.
    label = settings.llm.model?.trim() || new URL(settings.llm.baseUrl).host;
    tone = "remote";
  } else {
    label = "No model yet";
    tone = "none";
  }

  return (
    <button
      type="button"
      className={`modelbar tone-${tone}`}
      onClick={onOpen}
      title={
        tone === "local"
          ? `Running on this machine. ${runtime?.activeBuild?.backend ?? ""}`.trim()
          : tone === "remote"
            ? `Answering from ${settings?.llm.baseUrl}`
            : "Choose where Karen gets its answers"
      }
    >
      <span className={`dot dot-${tone === "local" ? "ready" : tone === "loading" ? "starting" : "idle"}`} />
      <span className="modelbar-name">{label}</span>
      {tone === "local" ? <span className="modelbar-where">on this machine</span> : null}
      {tone === "none" ? <span className="modelbar-where">set one up</span> : null}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
