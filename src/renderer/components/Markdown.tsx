import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from "marked";
import katex from "katex";
import { Component, type ReactNode } from "react";
import { isSafeExternalUrl } from "../../shared/safeUrl.ts";
import type { CitedSource } from "../types.ts";
import { withCitations } from "./Citations.tsx";
import { KATEX_OPTIONS, matchMathAt } from "./math.ts";

/*
 * Markdown, rendered as React elements rather than HTML.
 *
 * The obvious approach -- marked.parse() into dangerouslySetInnerHTML -- is not
 * available here. Everything in this pane is untrusted: model output, and page
 * text the model quotes back from the open web. Handing that to innerHTML makes
 * every fetched page a potential injection into the app's own origin, and the
 * sanitiser you would then need is one more thing to get wrong.
 *
 * So only marked's LEXER is used. It does the parsing, and the tokens are
 * turned into elements here. Nothing can become markup that this file does not
 * explicitly construct, and citation markers can be woven into inline text on
 * the way through.
 */

interface Ctx {
  sources: Map<number, CitedSource>;
  key: () => string;
}

/**
 * Maths, as its own token, found before anything else looks at the text.
 *
 * It has to be a tokenizer rather than a pass over the finished text, because
 * markdown gets to the subscripts first: `$x_1 + y_2$` contains two
 * underscores, and by the time a paragraph has been lexed the middle of that
 * equation is an <em> and the token boundaries no longer line up with the
 * delimiters. An inline extension runs before emphasis, so the equation is
 * lifted out whole and never offered to the emphasis rule at all.
 */
const mathExtension: TokenizerAndRendererExtension = {
  name: "math",
  level: "inline",
  /* Where the next candidate might be, so marked can skip ahead instead of
     asking about every character. */
  start(src: string) {
    const at = src.search(/\$|\\\(|\\\[/);
    return at === -1 ? undefined : at;
  },
  tokenizer(src: string) {
    const found = matchMathAt(src, 0);
    if (!found) return undefined;
    return { type: "math", raw: found.raw, text: found.value, display: found.display };
  },
};

/* Its own instance rather than marked.use(), which mutates the module for
   every other caller in the process. */
const lexer = new Marked({ gfm: true, breaks: true, extensions: [mathExtension] });

/**
 * KaTeX's output, which is the one place this file lets HTML through.
 *
 * Everything else here is built as React elements precisely so that nothing the
 * model wrote can become markup. Maths cannot work that way -- a rendered
 * equation IS markup, several hundred nested spans of it -- so the rule is
 * narrower instead of absent: the HTML comes from KaTeX, from a string KaTeX
 * itself parsed, with `trust` off. That switch is the whole question: with it
 * off KaTeX refuses \href, \url and \includegraphics, and every other command
 * produces spans and text that KaTeX escaped. The model's text is an argument
 * to a parser, never markup on its own account.
 *
 * `throwOnError` off, because half an equation is the normal state of a reply
 * that is still streaming, and an exception here would blank the answer.
 */
function Maths({ tex, display }: { tex: string; display: boolean }) {
  let html: string;
  try {
    html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
  } catch {
    /* KaTeX still throws for a few inputs even with throwOnError off. The
       source is then shown as the text it is, which is what happened before
       this feature existed and is never worse than that. */
    return <code className="md-math-raw">{tex}</code>;
  }
  const Tag = display ? "div" : "span";
  return (
    <Tag
      className={display ? "md-math md-math-display" : "md-math"}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Links in model prose get the same treatment as citations: external only. */
function Link({ href, children }: { href: string; children: ReactNode }) {
  // Anything that is not plain http(s) is shown as text. The main process
  // refuses other schemes anyway; not rendering them as links avoids inviting
  // the click at all.
  if (!isSafeExternalUrl(href)) return <>{children}</>;
  return (
    <a className="md-link" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function inline(tokens: Token[] | undefined, ctx: Ctx, fallback = ""): ReactNode[] {
  if (!tokens?.length) return fallback ? withCitations(fallback, ctx.sources) : [];
  const out: ReactNode[] = [];
  for (const t of tokens) {
    const k = ctx.key();
    switch (t.type) {
      case "text": {
        const tok = t as Tokens.Text;
        // A text token can itself hold inline tokens (marked nests them inside
        // list items and table cells); recurse when it does.
        if (tok.tokens?.length) out.push(<span key={k}>{inline(tok.tokens, ctx)}</span>);
        else out.push(<span key={k}>{withCitations(tok.text, ctx.sources)}</span>);
        break;
      }
      case "strong":
        out.push(<strong key={k}>{inline((t as Tokens.Strong).tokens, ctx)}</strong>);
        break;
      case "em":
        out.push(<em key={k}>{inline((t as Tokens.Em).tokens, ctx)}</em>);
        break;
      case "del":
        out.push(<del key={k}>{inline((t as Tokens.Del).tokens, ctx)}</del>);
        break;
      case "codespan":
        out.push(<code key={k} className="md-code-inline">{(t as Tokens.Codespan).text}</code>);
        break;
      case "br":
        out.push(<br key={k} />);
        break;
      case "link": {
        const tok = t as Tokens.Link;
        out.push(
          <Link key={k} href={tok.href}>
            {inline(tok.tokens, ctx, tok.text)}
          </Link>,
        );
        break;
      }
      case "image":
        // Images are never fetched: the app is default-deny on the network, so
        // the request would be cancelled and leave a broken frame. Show the alt.
        out.push(<em key={k} className="md-noimage">{(t as Tokens.Image).text || "image"}</em>);
        break;
      case "math": {
        const tok = t as unknown as { text: string; display: boolean };
        out.push(<Maths key={k} tex={tok.text} display={Boolean(tok.display)} />);
        break;
      }
      case "escape":
        out.push(<span key={k}>{(t as Tokens.Escape).text}</span>);
        break;
      case "html":
        // Raw HTML in the source is shown as the text it literally is.
        out.push(<span key={k}>{(t as Tokens.HTML).raw}</span>);
        break;
      default:
        out.push(<span key={k}>{withCitations((t as { raw?: string }).raw ?? "", ctx.sources)}</span>);
    }
  }
  return out;
}

function listItems(items: Tokens.ListItem[], ctx: Ctx): ReactNode[] {
  return items.map((item) => (
    <li key={ctx.key()} className={item.task ? "md-task" : undefined}>
      {item.task ? (
        <input type="checkbox" checked={!!item.checked} readOnly className="md-checkbox" />
      ) : null}
      {block(item.tokens ?? [], ctx, true)}
    </li>
  ));
}

/** Render block-level tokens. `tight` keeps list items from growing paragraphs. */
function block(tokens: Token[], ctx: Ctx, tight = false): ReactNode[] {
  const out: ReactNode[] = [];
  for (const t of tokens) {
    const k = ctx.key();
    switch (t.type) {
      case "space":
        break;
      case "heading": {
        const tok = t as Tokens.Heading;
        // Clamped to h3..h6: these sit inside a conversation, so a report's own
        // "# Title" must not outrank the app's real headings.
        const level = Math.min(6, tok.depth + 2);
        const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
        out.push(<Tag key={k} className={`md-h md-h${tok.depth}`}>{inline(tok.tokens, ctx)}</Tag>);
        break;
      }
      case "paragraph": {
        const tok = t as Tokens.Paragraph;
        if (tight) out.push(<span key={k}>{inline(tok.tokens, ctx, tok.text)}</span>);
        else out.push(<p key={k} className="md-p">{inline(tok.tokens, ctx, tok.text)}</p>);
        break;
      }
      case "text": {
        const tok = t as Tokens.Text;
        out.push(<span key={k}>{inline(tok.tokens, ctx, tok.text)}</span>);
        break;
      }
      case "list": {
        const tok = t as Tokens.List;
        if (tok.ordered) {
          out.push(
            <ol key={k} className="md-list" start={Number(tok.start) || 1}>
              {listItems(tok.items, ctx)}
            </ol>,
          );
        } else {
          out.push(<ul key={k} className="md-list">{listItems(tok.items, ctx)}</ul>);
        }
        break;
      }
      case "code": {
        const tok = t as Tokens.Code;
        out.push(
          <pre key={k} className="md-pre">
            <code>{tok.text}</code>
          </pre>,
        );
        break;
      }
      case "blockquote":
        out.push(
          <blockquote key={k} className="md-quote">
            {block((t as Tokens.Blockquote).tokens ?? [], ctx)}
          </blockquote>,
        );
        break;
      case "math": {
        const tok = t as unknown as { text: string; display: boolean };
        out.push(<Maths key={k} tex={tok.text} display={Boolean(tok.display)} />);
        break;
      }
      case "hr":
        out.push(<hr key={k} className="md-hr" />);
        break;
      case "table": {
        const tok = t as Tokens.Table;
        out.push(
          <div key={k} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {tok.header.map((cell, i) => (
                    <th key={i} style={{ textAlign: tok.align[i] ?? "left" }}>
                      {inline(cell.tokens, ctx, cell.text)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tok.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, i) => (
                      <td key={i} style={{ textAlign: tok.align[i] ?? "left" }}>
                        {inline(cell.tokens, ctx, cell.text)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        break;
      }
      case "html":
        out.push(<p key={k} className="md-p">{(t as Tokens.HTML).raw}</p>);
        break;
      default:
        out.push(<p key={k} className="md-p">{withCitations((t as { raw?: string }).raw ?? "", ctx.sources)}</p>);
    }
  }
  return out;
}

/**
 * Never let a rendering failure blank an answer.
 *
 * The input is untrusted and arrives in partial states as it streams, so an
 * unexpected token shape is a question of when, not whether. Falling back to the
 * raw text keeps the content readable; throwing would take out the transcript.
 */
class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function Markdown({
  text,
  sources,
}: {
  text: string;
  sources: Map<number, CitedSource>;
}) {
  return (
    <Boundary fallback={<span className="md-raw">{withCitations(text, sources)}</span>}>
      <Rendered text={text} sources={sources} />
    </Boundary>
  );
}

function Rendered({
  text,
  sources,
}: {
  text: string;
  sources: Map<number, CitedSource>;
}) {
  let n = 0;
  const ctx: Ctx = { sources, key: () => `m${n++}` };
  let tokens: Token[];
  try {
    // gfm covers tables, strikethrough and autolinks -- all of which appear in
    // research reports. Partial input is expected: this renders mid-stream.
    tokens = lexer.lexer(text);
  } catch {
    // A lexer failure must never blank the answer.
    return <span className="md-raw">{withCitations(text, sources)}</span>;
  }
  return <div className="md">{block(tokens, ctx)}</div>;
}
