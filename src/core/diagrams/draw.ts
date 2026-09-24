/**
 * Parse-or-place, shared by every consumer that turns a `DiagramUpdate` into a
 * `Layout` -- the full panel (`DiagramView.tsx`) and the inline chat thumbnail
 * alike. Kept here rather than duplicated so both draw from exactly the same
 * geometry, the same reason `layout.ts` and `svg.ts` are one set of numbers
 * for the screen and for export.
 */

import { layoutDiagram, type Layout } from "./layout.ts";
import { parseMermaid } from "./mermaid.ts";
import { LOOKS, type DiagramStyleName } from "./styles.ts";
import { prismaLayout } from "../prisma/layout.ts";
import type { PrismaFigure } from "../prisma/spec.ts";

export type DrawResult = { layout: Layout } | { error: string };

/** Exactly one of `source`/`prisma` is ever set, mirroring `DiagramUpdate`.
 *  A style applies to a Mermaid diagram only: a PRISMA figure's look is the
 *  official template, so it is placed the same whatever is asked. */
export function drawDiagram(
  diagram: { source?: string | undefined; prisma?: PrismaFigure | undefined },
  style?: DiagramStyleName,
): DrawResult {
  if (diagram.prisma) return { layout: prismaLayout(diagram.prisma) };
  const parsed = parseMermaid(diagram.source ?? "");
  if (!parsed.ok) return { error: `Line ${parsed.line}: ${parsed.error}` };
  return { layout: layoutDiagram(parsed.diagram, LOOKS[style ?? "standard"]) };
}
