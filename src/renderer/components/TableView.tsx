import { displayText } from "../../core/tabular/table.ts";
import { latexOf } from "../../core/tabular/latex.ts";
import { htmlOf, markdownOf, tsvOf } from "../../core/tabular/markdown.ts";
import type { TableUpdate } from "../types.ts";
import { headerUnitSuffix } from "./tableHeader.ts";
import { useSaid } from "./useSaid.ts";

/**
 * A table `create_table` built, drawn directly from its `DataTable` -- never
 * from a string the model wrote.
 *
 * Every cell here is `{displayText(table, r, c)}`, a React text child, the
 * same promise `DiagramView` and `Markdown.tsx` both make: nothing in this
 * component parses markup out of a string, so there is nothing for a
 * mis-escaped `%` or `|` to do here even in principle. The export buttons
 * below are the only place escaping matters, because `latexOf`/`htmlOf`
 * build a STRING by concatenation, where React would have escaped for free.
 */
export function TableView({ table: item }: { table: TableUpdate }) {
  const [said, say] = useSaid();
  const { table, style } = item;

  const copyWord = async (): Promise<void> => {
    const res = await window.myra.tableCopyWord(htmlOf(table, { title: item.title }), tsvOf(table));
    say(res.ok ? "Copied for Word" : res.error ?? "Could not copy it");
  };

  const copyLatex = (): void => {
    void window.myra.copy(latexOf(table, { title: item.title, style }));
    say("LaTeX copied");
  };

  const copyMarkdown = (): void => {
    void window.myra.copy(markdownOf(table));
    say("Markdown copied");
  };

  const saveLatex = async (): Promise<void> => {
    const res = await window.myra.tableSave(item.title, latexOf(table, { title: item.title, style }));
    say(res.ok ? "Saved to Documents" : res.error ?? "Could not save it");
  };

  return (
    <div className="tb">
      <div className="tb-canvas">
        <table className="md-table">
          <thead>
            <tr>
              {table.columns.map((col, c) => (
                <th key={c} style={{ textAlign: col.kind === "number" ? "right" : "left" }}>
                  {col.name}
                  {headerUnitSuffix(col) ? <span className="tb-unit"> ({headerUnitSuffix(col)})</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r}>
                {row.map((_cell, c) => (
                  <td
                    key={c}
                    style={{ textAlign: table.columns[c]!.kind === "number" ? "right" : "left" }}
                    /* Present but not a clean value -- a footnoted "12.3*" or
                       a censored "<0.001" -- is marked rather than silently
                       indistinguishable from a plain number, since a chart or
                       a statistic will refuse on exactly this cell. */
                    className={
                      table.columns[c]!.kind === "number" && !row[c]!.missing && row[c]!.value === undefined
                        ? "tb-unparsed"
                        : undefined
                    }
                    title={
                      table.columns[c]!.kind === "number" && !row[c]!.missing && row[c]!.value === undefined
                        ? "Not a plain number -- a chart or statistic would refuse this cell rather than guess its value."
                        : undefined
                    }
                  >
                    {displayText(table, r, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {item.notes.length ? (
        <ul className="tb-notes">
          {item.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}

      <div className="dg-acts">
        <button type="button" className="artifact-open" onClick={() => void copyWord()}>
          Copy for Word
        </button>
        <button type="button" className="artifact-open" onClick={copyLatex}>
          Copy LaTeX
        </button>
        <button type="button" className="artifact-open" onClick={copyMarkdown}>
          Copy Markdown
        </button>
        <button type="button" className="artifact-open" onClick={() => void saveLatex()}>
          Save .tex
        </button>
        {said ? <span className="dg-said">{said}</span> : null}
      </div>
    </div>
  );
}
