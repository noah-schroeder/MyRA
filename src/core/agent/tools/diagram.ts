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
import { assignCategoryColors, layoutDiagram } from "../../diagrams/layout.ts";
import { parseMermaid } from "../../diagrams/mermaid.ts";
import { DIAGRAM_STYLES, parseDiagramStyle, STYLE_LABELS, type DiagramStyleName } from "../../diagrams/styles.ts";
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
  /** The look the model asked for. Absent means whatever the panel's own menu
   *  was last set to -- and the menu can always change it. Never on PRISMA. */
  style?: DiagramStyleName | undefined;
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
    "optional label as `-->|text|`. To colour-code related steps, group nodes into up to 6 " +
    "named categories with `id:::categoryName` or a `class idA,idB categoryName` line; with " +
    "nothing else, MyRA picks a legible colour for each category. When the user asks for " +
    "particular colours, set them: `classDef categoryName fill:#cde4ff,stroke:#1f5fa8,color:#10233d` " +
    "colours every node in that category, `style id fill:#ffe0b2` colours one node, and " +
    "`linkStyle 0 stroke:#c62828,stroke-width:2px` colours an edge (edges are numbered from 0 in " +
    "the order written; `linkStyle default` colours them all). Colours are hex codes, rgb(), or CSS " +
    "colour names; the text colour is chosen for contrast when you do not give one. To recolour a " +
    "diagram already drawn, call this again with the same nodes and the new colour lines. " +
    "Set `style` only when the user asks for a look: \"poster\" for a poster or slides (bold, " +
    "large, rounded), \"journal\" for a manuscript (thin lines, Helvetica, print-safe colours), " +
    "\"monochrome\" for black-and-white print; leave it out otherwise, and the user can change it " +
    "from the figure. Only " +
    "flowcharts are supported: sequence, class, gantt and state diagrams are not, and " +
    "subgraphs are not. Prefer this over describing a diagram in prose or writing a Mermaid " +
    "code block, and call it again with corrected source if it returns an error.",
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
      style: {
        type: "string",
        enum: [...DIAGRAM_STYLES],
        description: "The look, only when the user asked for one: poster, journal, monochrome or standard",
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
    /* An unknown style is dropped rather than refused: the diagram is what was
       asked for, and the figure's own menu can still set the look. */
    const style = parseDiagramStyle(params["style"]);

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
    /* A second, cheap pass over the same groupings layoutDiagram already
       resolved -- run separately so a soft "some categories were dropped"
       note stays a concern of the tool's reply text, not of the layout. */
    const { overflow } = assignCategoryColors(parsed.diagram);

    const id = nextDiagramId();
    announceDiagram({ id, title, source, ...(style ? { style } : {}) });

    return {
      content:
        `Drew "${title}": ${layout.nodes.length} ` +
        `${layout.nodes.length === 1 ? "node" : "nodes"} and ${layout.edges.length} ` +
        `${layout.edges.length === 1 ? "edge" : "edges"}` +
        (style && style !== "standard" ? ` in the ${STYLE_LABELS[style]} style` : "") +
        `. It is shown to the user beside the ` +
        "conversation, where they can export it as SVG or PNG. Do not repeat the diagram " +
        "source in your reply; say what it shows." +
        (overflow.length
          ? ` Only the first 6 categories are shown in colour; "${overflow.join('", "')}" ` +
            `${overflow.length === 1 ? "uses" : "use"} the default look.`
          : "") +
        /* Drawn anyway, and said: a colour that did not parse is a detail the
           model can fix on its next call, not a reason to show nothing. */
        (parsed.warnings?.length ? `\n\nNot everything was applied:\n${parsed.warnings.map((w) => `- ${w}`).join("\n")}` : ""),
      detail: { id, title, source, ...(style ? { style } : {}) },
    };
  },
};

export const DIAGRAM_TOOL_DEFS: ToolDef[] = [createDiagramTool];
