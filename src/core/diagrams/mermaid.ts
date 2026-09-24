/**
 * Mermaid flowchart syntax, parsed rather than vendored.
 *
 * The model writes Mermaid because every model writes Mermaid -- it is in all
 * of their training data, and a schema MyRA invented would be one a 2.6B
 * declines to follow, which is the failure `documents/draft.ts` exists to
 * prevent. What MyRA does not do is run Mermaid: the package is 118 MB across
 * 23 dependency families, against an app whose entire runtime dependency list
 * is `katex` and `marked`, and it renders by generating an HTML string. Diagram
 * source is model output, sometimes quoted from a fetched page, and
 * `Markdown.tsx` already refuses that bargain in its opening paragraph --
 * nothing becomes markup this app did not construct.
 *
 * So this reads the flowchart subset into a shape, `layout.ts` places it and
 * `scene.ts` turns it into primitives the renderer draws as React elements.
 * Everything a label contains ends up as the text of an SVG `<text>` node,
 * which cannot be anything else.
 *
 * **What is not supported is refused, never half-drawn.** `sequenceDiagram`,
 * `gantt`, `classDiagram` and subgraphs parse far enough to be recognised and
 * are then reported by name, because a diagram missing a third of itself is
 * worse than one that says it cannot be drawn -- and because the message is
 * what the model reads and acts on.
 */

export type Direction = "TD" | "TB" | "BT" | "LR" | "RL";

/** The node shapes Mermaid's bracket forms select. */
export type NodeShape =
  | "rect" | "round" | "stadium" | "subroutine"
  | "diamond" | "hexagon" | "circle" | "cylinder" | "flag";

export interface DiagramNode {
  id: string;
  label: string;
  shape: NodeShape;
  /** A grouping key from `class`/`:::`, never a colour -- MyRA owns the
   *  palette that eventually paints it, the same reason `classDef`'s own
   *  colours are read nowhere in this file. */
  category?: string | undefined;
}

export type EdgeStyle = "solid" | "dotted" | "thick";

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string | undefined;
  style: EdgeStyle;
  /** `-->` has one, `---` does not. */
  arrow: boolean;
}

export interface Diagram {
  direction: Direction;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export type ParseResult =
  | { ok: true; diagram: Diagram }
  | { ok: false; line: number; error: string };

/** The opening keyword of every diagram type, so an unsupported one is named. */
const OTHER_DIAGRAMS = [
  "sequenceDiagram", "classDiagram", "stateDiagram", "stateDiagram-v2", "erDiagram",
  "gantt", "pie", "journey", "mindmap", "timeline", "quadrantChart", "sankey-beta",
  "gitGraph", "C4Context", "requirementDiagram", "block-beta", "xychart-beta",
];

const DIRECTIONS: Record<string, Direction> = {
  TD: "TD", TB: "TB", BT: "BT", LR: "LR", RL: "RL",
};

/**
 * Bracket pairs, longest opener first.
 *
 * Order matters and is the whole reason this is a list rather than an object:
 * `[[` has to be tried before `[`, or `A[[Subroutine]]` parses as a rectangle
 * whose label begins with a bracket.
 */
const SHAPES: { open: string; close: string; shape: NodeShape }[] = [
  { open: "([", close: "])", shape: "stadium" },
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "((", close: "))", shape: "circle" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
  { open: ">", close: "]", shape: "flag" },
];

/**
 * `A -- yes --> B` becomes `A -->|yes| B`, so the scanner sees one label form.
 *
 * The lookahead is load-bearing: without `(?![->=])` the pattern also matches
 * the `--` of a plain `A --> B --> C`, taking `> B` as the label of a chain
 * that has none.
 *
 * A label that itself contains a literal `|` -- `A -- yes|no --> B` -- is
 * quoted before it is rewritten into the piped form, so the reader below
 * (which honours a leading quote the same way `readNode`'s bracket-label
 * reader already does) finds the real closing `|` instead of the first one
 * inside the label. Left unquoted, that first embedded `|` was read as the
 * label's end and the remainder as a bogus one-token node id -- an error
 * naming a node that never appeared in the source, defeating the whole
 * point of returning a message the model can act on. Already-quoted text is
 * left alone rather than quoted twice.
 */
function normaliseInlineLabels(text: string): string {
  const wrap = (label: string): string =>
    label.includes("|") && !(label.startsWith('"') && label.endsWith('"')) ? `"${label}"` : label;
  return text
    .replace(/--(?![->])\s*(.+?)\s*--(>?)/g, (_m, label: string, head: string) => `--${head}|${wrap(label)}|`)
    .replace(/==(?![=>])\s*(.+?)\s*==(>?)/g, (_m, label: string, head: string) => `==${head}|${wrap(label)}|`)
    .replace(/-\.(?!-)\s*(.+?)\s*\.-(>?)/g, (_m, label: string, head: string) => `-.-${head}|${wrap(label)}|`);
}

/** Every edge operator, longest first so `-->` wins over `--`. */
const EDGE_OPS: { re: RegExp; style: EdgeStyle; arrow: boolean }[] = [
  { re: /^-\.-+>/, style: "dotted", arrow: true },
  { re: /^-\.-+/, style: "dotted", arrow: false },
  { re: /^={2,}>/, style: "thick", arrow: true },
  { re: /^={2,}/, style: "thick", arrow: false },
  { re: /^-{2,}>/, style: "solid", arrow: true },
  { re: /^-{2,}/, style: "solid", arrow: false },
];

/**
 * A node id, which may hold `-` and `.` only between other characters.
 *
 * `node-1` and `a.b` are real Mermaid ids, so the characters have to be
 * allowed -- but a class that simply included them read `A-->B` as an id of
 * `A--` followed by `>B`, which then parsed as the opening of a flag-shaped
 * node and failed on its missing `]`. Requiring something alphanumeric after
 * each one stops the id at the first dash of an arrow without giving up ids
 * that legitimately contain one.
 */
const ID = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*/;

interface NodeRef {
  id: string;
  label?: string | undefined;
  shape?: NodeShape | undefined;
  category?: string | undefined;
}

/**
 * `id:::categoryName`, Mermaid's terser alternative to a `class` statement and
 * the one a model reaches for first. Tried after a node (and its bracket
 * label, if any) is otherwise fully read, so it also has to be tried when
 * there was no bracket at all -- `A:::blue` is as valid as `A[Label]:::blue`.
 * Left unhandled, the leading `:` fell through to the edge-operator reader
 * and failed with "Expected an arrow after A".
 */
const CATEGORY_SUFFIX = /^:::([A-Za-z_][\w-]*)/;

function readCategorySuffix(text: string, ref: NodeRef, at: number): { ref: NodeRef; next: number } {
  const m = CATEGORY_SUFFIX.exec(text.slice(at));
  if (!m) return { ref, next: at };
  return { ref: { ...ref, category: m[1]! }, next: at + m[0]!.length };
}

/** Read one node reference, with its bracket label when it carries one. */
function readNode(text: string, at: number): { ref: NodeRef; next: number } | undefined {
  const rest = text.slice(at);
  const m = ID.exec(rest);
  if (!m) return undefined;
  const id = m[0];
  let pos = at + id.length;

  for (const { open, close, shape } of SHAPES) {
    if (!text.startsWith(open, pos)) continue;
    const from = pos + open.length;
    /* A quoted label may hold the closing bracket itself -- `A["a] b"]` -- so
       quotes are honoured before the bracket search rather than after it. */
    if (text[from] === '"') {
      const end = text.indexOf('"', from + 1);
      if (end < 0) return undefined;
      if (!text.startsWith(close, end + 1)) return undefined;
      return readCategorySuffix(text, { id, label: text.slice(from + 1, end), shape }, end + 1 + close.length);
    }
    const end = text.indexOf(close, from);
    if (end < 0) return undefined;
    return readCategorySuffix(text, { id, label: text.slice(from, end).trim(), shape }, end + close.length);
  }
  return readCategorySuffix(text, { id }, pos);
}

/**
 * Split one line into `;`-separated statements, without splitting inside a
 * quoted label -- `A["Choice; pick one"] --> B` is one statement, not two
 * fragments broken at the label's own semicolon.
 *
 * A minimal quote tracker rather than a real tokeniser: this file already
 * builds one for reading a node's own bracket label (`readNode`), but that
 * one runs after a statement is already isolated -- this has to isolate the
 * statement first, before anything else here can see the label at all.
 */
function splitStatements(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ";" && !inQuotes) {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  return parts;
}

/** `class A,B,C categoryName` -- a category is a grouping key, never a colour;
 *  see `CATEGORY_SUFFIX` above for the terser `:::categoryName` form. */
const CLASS_STATEMENT = /^class\s+([\w.-]+(?:\s*,\s*[\w.-]+)*)\s+([A-Za-z_][\w-]*)\s*;?$/;

export function parseMermaid(source: string): ParseResult {
  const raw = source.split(/\r?\n/);
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  let direction: Direction | undefined;

  const remember = (ref: NodeRef): void => {
    const existing = nodes.get(ref.id);
    if (!existing) {
      nodes.set(ref.id, {
        id: ref.id, label: ref.label ?? ref.id, shape: ref.shape ?? "rect",
        ...(ref.category !== undefined ? { category: ref.category } : {}),
      });
      return;
    }
    /* A node may be introduced bare and given its label later -- `A --> B` then
       `B[Screened]` -- so a later mention that carries one wins over the id
       standing in for it. A category works the same way: `class A,B blue`
       commonly comes after the nodes it names, but `A:::blue --> B[Label]`
       gives the category first, so whichever arrives is kept until a later
       mention overwrites it. */
    if (ref.label !== undefined) existing.label = ref.label;
    if (ref.shape !== undefined) existing.shape = ref.shape;
    if (ref.category !== undefined) existing.category = ref.category;
  };

  for (let i = 0; i < raw.length; i++) {
    const lineNo = i + 1;
    const line = (raw[i] ?? "").replace(/%%.*$/, "").trim();
    if (!line) continue;

    if (direction === undefined) {
      const other = OTHER_DIAGRAMS.find((k) => line === k || line.startsWith(`${k} `));
      if (other) {
        return {
          ok: false, line: lineNo,
          error:
            `MyRA draws Mermaid flowcharts; \`${other}\` is a diagram type it cannot draw yet. ` +
            "Rewrite it as `flowchart TD` (or `LR`) using nodes and arrows.",
        };
      }
      const head = /^(?:graph|flowchart)\s+([A-Za-z]{2})\b/.exec(line);
      if (!head) {
        return {
          ok: false, line: lineNo,
          error:
            "A flowchart has to open with `flowchart TD` (top-down) or `flowchart LR` " +
            `(left-right). Found \`${line.slice(0, 40)}\`.`,
        };
      }
      const dir = DIRECTIONS[head[1]!.toUpperCase()];
      if (!dir) {
        return {
          ok: false, line: lineNo,
          error: `\`${head[1]}\` is not a direction. Use TD, TB, BT, LR or RL.`,
        };
      }
      direction = dir;
      const after = line.slice(head[0].length).trim();
      if (!after) continue;
      const statement = parseStatement(after, remember, edges);
      if (statement) return { ok: false, line: lineNo, error: statement };
      continue;
    }

    if (/^subgraph\b/.test(line)) {
      return {
        ok: false, line: lineNo,
        error:
          "Subgraphs are not drawn yet. Group the steps with edge labels, or draw the " +
          "grouping as its own nodes joined by dotted edges (`-.->`).",
      };
    }
    if (/^(end|classDef|style|linkStyle|click)\b/.test(line)) continue;
    if (/^class\b/.test(line)) {
      /* `classDef`'s own colours are never read -- only which nodes share a
         category matters, so `class` is the one discarded directive that is
         now actually parsed. A line that does not match the `class <ids>
         <name>` shape is still swallowed rather than reported: every other
         directive on this line has always been ignored silently, and an
         unrecognised spelling of this one should fail the same quiet way
         rather than surface as a parse error over a feature the model was
         never asked to use carefully. */
      const m = CLASS_STATEMENT.exec(line);
      if (m) {
        const category = m[2]!;
        for (const id of m[1]!.split(",")) {
          const trimmed = id.trim();
          if (trimmed) remember({ id: trimmed, category });
        }
      }
      continue;
    }

    for (const part of splitStatements(line)) {
      if (!part.trim()) continue;
      const problem = parseStatement(part.trim(), remember, edges);
      if (problem) return { ok: false, line: lineNo, error: problem };
    }
  }

  if (direction === undefined) {
    return { ok: false, line: 1, error: "Nothing to draw: the diagram is empty." };
  }
  if (!nodes.size) {
    return {
      ok: false, line: 1,
      error: "The flowchart has a direction but no nodes. Add at least one, as `A[Label]`.",
    };
  }
  return { ok: true, diagram: { direction, nodes: [...nodes.values()], edges } };
}

/** One statement: a node, or a chain of nodes joined by edges. Returns an error. */
function parseStatement(
  input: string,
  remember: (ref: NodeRef) => void,
  edges: DiagramEdge[],
): string | undefined {
  const text = normaliseInlineLabels(input);
  let at = 0;
  const skip = (): void => { while (at < text.length && /\s/.test(text[at]!)) at++; };

  skip();
  const first = readNode(text, at);
  if (!first) return `Could not read a node from \`${input.slice(0, 40)}\`.`;
  remember(first.ref);
  at = first.next;

  let previous = first.ref.id;
  for (;;) {
    skip();
    if (at >= text.length) return undefined;

    const rest = text.slice(at);
    const op = EDGE_OPS.find((o) => o.re.test(rest));
    if (!op) {
      return (
        `Expected an arrow after \`${previous}\`, found \`${rest.slice(0, 20)}\`. ` +
        "Arrows are `-->`, `---`, `-.->` or `==>`."
      );
    }
    at += op.re.exec(rest)![0].length;

    let label: string | undefined;
    if (text[at] === "|") {
      const from = at + 1;
      /* A quoted label may hold the closing `|` itself, the same reason
         readNode's bracket-label reader checks for a leading quote before
         searching for its own closing bracket. */
      if (text[from] === '"') {
        const closeQuote = text.indexOf('"', from + 1);
        if (closeQuote < 0 || text[closeQuote + 1] !== "|") {
          return `An edge label after \`${previous}\` is missing its closing \`|\`.`;
        }
        label = text.slice(from + 1, closeQuote);
        at = closeQuote + 2;
      } else {
        const end = text.indexOf("|", from);
        if (end < 0) return `An edge label after \`${previous}\` is missing its closing \`|\`.`;
        label = text.slice(from, end).trim().replace(/^"|"$/g, "");
        at = end + 1;
      }
    }

    skip();
    const target = readNode(text, at);
    if (!target) {
      return `The arrow after \`${previous}\` does not reach a node. Add the node it points to.`;
    }
    remember(target.ref);
    edges.push({
      from: previous, to: target.ref.id, style: op.style, arrow: op.arrow,
      ...(label ? { label } : {}),
    });
    previous = target.ref.id;
    at = target.next;
  }
}
