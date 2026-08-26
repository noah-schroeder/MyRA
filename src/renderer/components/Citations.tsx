import { useRef, useState, type ReactNode } from "react";
import type { CitedSource } from "../types.ts";
import { MARKER, markerNumbers } from "./citeMarkers.ts";

/*
 * Turning [n] markers in model prose into links.
 *
 * The numbers come from the tools, not the model: web_search assigns one per
 * URL for the whole session and deep_research hands over the table its citation
 * audit ran against. So a marker either resolves to something really retrieved,
 * or it does not resolve at all -- and an unresolved marker is left as plain
 * text rather than dressed up as a link to nowhere.
 */

function subtitle(s: CitedSource): string {
  const bits: string[] = [];
  if (s.authors?.length) {
    bits.push(s.authors.slice(0, 3).join(", ") + (s.authors.length > 3 ? ", et al." : ""));
  }
  if (s.year) bits.push(String(s.year));
  else if (s.publishedDate) bits.push(s.publishedDate);
  if (s.venue) bits.push(s.venue);
  else if (s.engine) bits.push(`via ${s.engine}`);
  return bits.join(" · ");
}

/** Roughly the card's width; used to keep it inside the window. */
const CARD_W = 360;
const GAP = 8;

/** One [n], as a link with a hover card describing what it points at. */
function Citation({ n, source }: { n: number; source: CitedSource }) {
  /*
   * The card is positioned fixed, not absolute.
   *
   * Absolute positioning put it inside the scrolling transcript, where it did
   * two bad things: it was clipped by the window edges (citations sit at the
   * end of sentences, so most of them are near the right edge), and it widened
   * the scroll area, which made a horizontal scrollbar appear on hover.
   *
   * Fixed coordinates measured from the marker avoid both, at the cost of
   * having to clamp to the viewport by hand.
   */
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | undefined>();
  const ref = useRef<HTMLAnchorElement>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(
      Math.max(GAP, r.left + r.width / 2 - CARD_W / 2),
      Math.max(GAP, window.innerWidth - CARD_W - GAP),
    );
    // Above by default; below when the marker sits too near the top for the
    // card to fit, which is exactly where a first-paragraph citation lands.
    setAt(
      r.top < 240
        ? { left, top: r.bottom + GAP }
        : { left, bottom: window.innerHeight - r.top + GAP },
    );
  };

  const meta = subtitle(source);

  return (
    <span className="cite-wrap" onMouseEnter={show} onMouseLeave={() => setAt(undefined)}>
      <a
        ref={ref}
        className="cite"
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        onFocus={show}
        onBlur={() => setAt(undefined)}
      >
        {n}
      </a>
      {at ? (
        <span
          className="cite-card"
          role="tooltip"
          style={{
            left: at.left,
            ...(at.top !== undefined ? { top: at.top } : {}),
            ...(at.bottom !== undefined ? { bottom: at.bottom } : {}),
          }}
        >
          <span className="cite-card-title">{source.title}</span>
          {meta ? <span className="cite-card-meta">{meta}</span> : null}
          {source.snippet ? <span className="cite-card-snippet">{source.snippet}</span> : null}
          <span className="cite-card-url">{source.url}</span>
          {source.note || source.via === "abstract" ? (
            <span className="cite-card-note">
              {source.via === "abstract" ? "abstract only" : source.note}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Split prose on citation markers, linking the ones that resolve.
 *
 * Returns an array of nodes rather than a wrapper element, so the caller keeps
 * control of the surrounding block and its whitespace handling.
 */
export function withCitations(text: string, sources: Map<number, CitedSource>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const m of text.matchAll(MARKER)) {
    const at = m.index ?? 0;
    const numbers = markerNumbers(m[1]!);
    if (numbers.length === 0) continue;

    /*
     * A marker nothing backs is shown as unsupported, not as a citation.
     *
     * It used to be left as literal text, on the reasoning that an honest "[4]"
     * beats a link that goes nowhere. That was half right: to a reader, "[4]"
     * at the end of a sentence *is* the claim that a source exists, and models
     * write it out of habit — a small one asked a question with searching off
     * produced "…Rayleigh scattering [1]." with no tool call in the turn. It is
     * not deleted either, because that would edit what the model said. It is
     * marked, so the page tells the truth about what is behind it.
     */
    const resolved = numbers.filter((n) => sources.has(n));
    if (resolved.length !== numbers.length) {
      if (at > last) out.push(text.slice(last, at));
      out.push(
        <span
          key={`v${key++}`}
          className="cite-void"
          title="No source backs this. Nothing was cited in this conversation."
        >
          {m[0]}
        </span>,
      );
      last = at + m[0].length;
      continue;
    }

    if (at > last) out.push(text.slice(last, at));
    out.push(
      <span className="cite-group" key={`c${key++}`}>
        [
        {numbers.map((n, i) => (
          <span key={n}>
            {i > 0 ? ", " : ""}
            <Citation n={n} source={sources.get(n)!} />
          </span>
        ))}
        ]
      </span>,
    );
    last = at + m[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
