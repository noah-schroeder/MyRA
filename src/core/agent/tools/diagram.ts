/**
 * Drawing a flowchart, as a tool rather than as a code fence.
 *
 * A model can already emit a ```mermaid block and have it rendered, and that is
 * not enough. A tool is what makes three things true that a code fence leaves
 * to chance.
 *
 * **The diagram is checked before anybody sees it.** `parseMermaid` either
 * produces a drawing or an error naming the line, and that error is returned as
 * the tool's own result -- which the model reads and acts on. The repair loop
 * people usually write as orchestration is, here, the ordinary agent loop doing
 * what it already does with a failed call. A malformed code fence, by contrast,
 * renders as a broken box under a confident sentence.
 *
 * **It becomes an artifact rather than a message.** A figure is worked on: it
 * gets exported to SVG for the manuscript, to PNG for the slide, and revised
 * three times before either. A code fence scrolls away.
 *
 * **What is not drawable is refused by name.** A `sequenceDiagram` comes back
 * saying so, so the model rewrites it as a flowchart instead of the user
 * getting a paragraph apologising for an empty box.
 *
 * `safe` rather than `write`: nothing here touches a disk. The drawing is held
 * in the conversation and written out only when a person presses Export, which
 * is their action and not the agent's.
 */

import type { ToolDef, ToolResult } from "../registry.ts";
import { layoutDiagram } from "../../diagrams/layout.ts";
import { parseMermaid } from "../../diagrams/mermaid.ts";
import type { PrismaFigure } from "../../prisma/spec.ts";
import { makeIdCounter, makeWatcher } from "./artifactWatch.ts";

/**
 * A drawn diagram, pushed at whatever is showing them.
 *
 * Exactly one of `source`/`prisma` is ever set. Both optional rather than a
 * discriminated union: this channel had one producer and one shape for a long
 * time, and `create_prisma_diagram` is the second producer of the same
 * artifact panel entry, drawn from a placed figure rather than parsed Mermaid
 * -- widening the shape here is smaller than giving it a second channel, and
 * `DiagramView.tsx` already has to branch on which one it got.
 */
export interface DiagramUpdate {
  /** Stable for the life of the conversation, so a redraw replaces its predecessor. */
  id: string;
  title: string;
  /** The Mermaid source, kept so it can be edited and re-rendered. */
  source?: string | undefined;
  /** A PRISMA 2020 figure, placed directly rather than parsed from Mermaid. */
  prisma?: PrismaFigure | undefined;
}

const diagramWatcher = makeWatcher<DiagramUpdate>();

/**
 * Left uninstalled, drawing a diagram tells nobody -- which is the right
 * behaviour for the test suite and for a headless run.
 */
export function setDiagramWatcher(fn: ((diagram: DiagramUpdate) => void) | undefined): void {
  diagramWatcher.set(fn);
}

/** Push a drawn figure at whatever is showing them. Shared with tools/prisma.ts. */
export function announceDiagram(update: DiagramUpdate): void {
  diagramWatcher.announce(update);
}

/** Counter rather than a random id: a conversation's diagrams are ordered,
    whichever tool drew each one. */
const diagramIds = makeIdCounter("diagram");

/** The next id in that one sequence. Shared with tools/prisma.ts. */
export function nextDiagramId(): string {
  return diagramIds.next();
}

/** Reset between conversations, so ids restart with the thread. Takes an
 *  optional starting point for a conversation whose earlier diagrams were
 *  just replayed, so the next one continues the sequence past them. */
export function resetDiagramIds(from = 0): void {
  diagramIds.reset(from);
}

export const createDiagramTool: ToolDef = {
  name: "create_diagram",
  description:
    "Draw a flowchart, architecture diagram or process diagram and show it to the user as a " +
    "figure they can export. Give the diagram in Mermaid flowchart syntax, starting with " +
    "`flowchart TD` (top-down) or `flowchart LR` (left-right). Nodes are `id[Label]`, " +
    "`id{Decision}`, `id([Rounded])`; arrows are `-->`, `---`, `-.->` and `==>`, with an " +
    "optional label as `-->|text|`. Only flowcharts are supported: sequence, class, gantt and " +
    "state diagrams are not, and subgraphs are not. Prefer this over describing a diagram in " +
    "prose or writing a Mermaid code block, and call it again with corrected source if it " +
    "returns an error.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A short caption for the figure, as it would read in a paper",
      },
      source: {
        type: "string",
        description: "The diagram, in Mermaid flowchart syntax",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const source = typeof params["source"] === "string" ? params["source"] : "";
    const title = typeof params["title"] === "string" && params["title"].trim()
      ? params["title"].trim()
      : "Diagram";

    if (!source.trim()) {
      return { content: "No diagram source was given. Pass `source` as Mermaid flowchart syntax." };
    }

    const parsed = parseMermaid(source);
    if (!parsed.ok) {
      /* The whole repair loop. Returned as the tool's result so the model reads
         it and calls again with the line fixed -- no retry machinery, because
         the agent loop already does this for every other failing call. */
      return {
        content:
          `The diagram could not be drawn. Line ${parsed.line}: ${parsed.error}\n\n` +
          "Call create_diagram again with the corrected source.",
      };
    }

    /* Laid out here rather than in the window so a diagram that parses but
       cannot be placed fails as a tool result too, where the model can react,
       instead of as an empty panel. */
    const layout = layoutDiagram(parsed.diagram);

    const id = nextDiagramId();
    announceDiagram({ id, title, source });

    return {
      content:
        `Drew "${title}": ${layout.nodes.length} ` +
        `${layout.nodes.length === 1 ? "node" : "nodes"} and ${layout.edges.length} ` +
        `${layout.edges.length === 1 ? "edge" : "edges"}. It is shown to the user beside the ` +
        "conversation, where they can export it as SVG or PNG. Do not repeat the diagram " +
        "source in your reply; say what it shows.",
      detail: { id, title, source },
    };
  },
};

export const DIAGRAM_TOOL_DEFS: ToolDef[] = [createDiagramTool];
