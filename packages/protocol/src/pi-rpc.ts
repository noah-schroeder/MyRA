/**
 * Types for pi's RPC mode (`pi --mode rpc`), a JSONL protocol over stdin/stdout.
 *
 * Verified against the spec bundled with pi 0.84.2
 * (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md) rather than the
 * website, which is out of date in places -- notably `set_model` takes
 * `modelId`, not `model`.
 *
 * pi is an independently evolving upstream, so these types stay PERMISSIVE:
 * known fields are typed, unknown ones pass through via index signatures. Karen
 * forwards RPC payloads opaquely, so a pi release that adds an event must never
 * crash the bridge.
 */

export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** Commands Karen sends to pi (stdin). Every command may carry a correlation `id`. */
export type PiCommand = { id?: string } & (
  // Prompting
  | { type: "prompt"; message: string; images?: PiImage[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: PiImage[] }
  | { type: "follow_up"; message: string; images?: PiImage[] }
  | { type: "abort" }
  // State
  | { type: "new_session" }
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "get_session_stats" }
  // Model
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "get_available_models" }
  // Thinking
  | { type: "set_thinking_level"; level: PiThinkingLevel }
  | { type: "cycle_thinking_level" }
  | { type: "get_available_thinking_levels" }
  // Queue modes
  | { type: "set_steering_mode"; mode: string }
  | { type: "set_follow_up_mode"; mode: string }
  // Compaction / retry
  | { type: "compact" }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "abort_retry" }
  // Bash
  | { type: "bash"; command: string }
  | { type: "abort_bash" }
  // Session
  | { type: "switch_session"; sessionPath: string }
  | { type: "fork"; entryId: string }
  | { type: "clone" }
  | { type: "get_fork_messages"; entryId: string }
  | { type: "get_entries"; since?: string }
  | { type: "get_tree" }
  | { type: "get_last_assistant_text" }
  | { type: "set_session_name"; name: string }
  | { type: "export_html"; path: string }
  | { type: "get_commands" }
);

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/** Reply to a dialog-type extension UI request (stdin). */
export type PiExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type PiOutbound = PiCommand | PiExtensionUiResponse;

/* ------------------------------------------------------------------ */

/** A model as pi reports it (get_state, set_model, get_available_models). */
export interface PiModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface PiState {
  model: PiModel;
  thinkingLevel: PiThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string;
  followUpMode: string;
  sessionId: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** An append-only session entry. Its `id` doubles as a durable cursor. */
export interface PiEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface PiEntriesData {
  entries: PiEntry[];
  /** Current leaf, or null for an empty session. Persist this as the cursor. */
  leafId: string | null;
}

/** Response to a command, correlated by `id`. */
export interface PiResponse<T = unknown> {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * A request from a pi extension for the client to render native UI.
 *
 * Dialog methods (`select`, `confirm`, `input`, `editor`) block until Karen
 * sends a matching `extension_ui_response`. The rest are fire-and-forget and may
 * be displayed or ignored. If `timeout` is present the agent side auto-resolves
 * on expiry, so the client need not track it.
 *
 * This is the mechanism Karen's approval dialogs ride on.
 */
export interface PiExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: PiUiDialogMethod | PiUiFireAndForgetMethod | string;
  title?: string;
  message?: string;
  options?: string[];
  timeout?: number;
  [key: string]: unknown;
}

export const PI_UI_DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export type PiUiDialogMethod = (typeof PI_UI_DIALOG_METHODS)[number];

export const PI_UI_FIRE_AND_FORGET_METHODS = [
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
] as const;
export type PiUiFireAndForgetMethod = (typeof PI_UI_FIRE_AND_FORGET_METHODS)[number];

export function isDialogMethod(method: string): method is PiUiDialogMethod {
  return (PI_UI_DIALOG_METHODS as readonly string[]).includes(method);
}

/* ------------------------------------------------------------------ */

export const PI_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
] as const;
export type PiEventType = (typeof PI_EVENT_TYPES)[number];

export interface PiContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface PiToolExecutionStart {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface PiToolExecutionUpdate {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  partialResult?: { content?: PiContentBlock[] };
}

export interface PiToolExecutionEnd {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result?: { content?: PiContentBlock[]; details?: unknown };
  isError?: boolean;
}

/** Catch-all for events we forward but do not introspect. */
export interface PiGenericEvent {
  type: string;
  [key: string]: unknown;
}

export type PiFrame =
  | PiResponse
  | PiExtensionUiRequest
  | PiToolExecutionStart
  | PiToolExecutionUpdate
  | PiToolExecutionEnd
  | PiGenericEvent;

export function isExtensionUiRequest(f: PiFrame): f is PiExtensionUiRequest {
  return f.type === "extension_ui_request";
}

export function isResponse(f: PiFrame): f is PiResponse {
  return f.type === "response";
}

export function isToolExecutionEvent(
  f: PiFrame,
): f is PiToolExecutionStart | PiToolExecutionUpdate | PiToolExecutionEnd {
  return (
    f.type === "tool_execution_start" ||
    f.type === "tool_execution_update" ||
    f.type === "tool_execution_end"
  );
}
