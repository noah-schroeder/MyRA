import { useCallback, useEffect, useState } from "react";
import { exactly, searches } from "../../core/research/ladder.ts";
import { DATABASES, DEFAULT_DATABASES, databaseLabel } from "../../core/research/databases.ts";
import type { CollectionNode, ResearchConfig, ResearchMode } from "../types.ts";

/**
 * One control for the whole question of how far MyRA may reach.
 *
 * Five of these six choices are a ladder, each rung a superset of the one
 * below: nothing, then your files, then your own library, then the literature,
 * then the literature done properly. The sixth takes the model out of the loop
 * entirely and hands the query to OpenAlex and arXiv directly.
 *
 * "Library" sits below "Quick" rather than beside it because it reaches further
 * into THIS MACHINE rather than outward: Zotero answers on loopback with no
 * key, so nothing leaves. That placement is most of the point -- it is what
 * makes a personal library searchable by someone who keeps the web switched
 * off. They were two separate controls --
 * a mode switch here and a "Look up papers" button beside it -- which read as
 * unrelated features when they are really one decision, and hid the fastest of
 * them behind a modal.
 *
 * The two rings say the thing the ladder implies but never states: where the
 * line is. Rungs differ from one another in a dozen small ways and in exactly
 * one way that matters to a person deciding what they are comfortable with, and
 * that one is not legible from an ordered row of six buttons. Drawn as a
 * boundary it is legible without being read.
 *
 * The labels name what each rung can reach, not how hard it tries, because the
 * thing a person needs to predict is what MyRA might do without being asked.
 * "Off" in particular has to be true: it used to leave the three document tools
 * in the schema, so a model greeted with "hi" had something to call and called
 * it, under a button that said the opposite.
 *
 * "Look up" is deliberately not a persisted mode. It changes nothing about what
 * the agent may do on your next turn; it changes where the composer sends what
 * you type. Leaving it restores the mode you had, rather than silently having
 * turned research off while you were reading. It sits under "Web" all the same:
 * the ring is about where the query goes, and this one goes to OpenAlex.
 */
interface Rung { value: ResearchMode; label: string; hint: string }

const LOCAL: Rung[] = [
  { value: "off", label: "Off", hint: "No tools at all. The model answers from what it knows, and cannot search, open a URL, or touch a file." },
  { value: "assistant", label: "Documents", hint: "The model can read and write in your documents folder. It still cannot reach the network." },
  { value: "library", label: "Zotero", hint: "The model can also search your own Zotero library — your collected papers, on this machine. Still no network, and Zotero must be open." },
];

const WEB: Rung[] = [
  { value: "web", label: "Quick", hint: "The model searches the databases chosen below, and cites what it used. Seconds." },
  { value: "deep", label: "Deep", hint: "Plan, search, read, verify and synthesise a cited report. Minutes." },
];

const LOCAL_HINT = "Nothing leaves this machine in these three. Zotero answers on loopback, so a library search is no more of an egress than opening a file.";
const WEB_HINT = "These reach the internet: the databases chosen below, and the pages they point at.";
const LOOKUP_HINT = "Search the databases chosen below yourself. No model, no waiting, nothing logged.";

/* Scholarly is the only body of literature this build can search, so it is not
   offered as a choice; it is stored so the setting survives a future one. */
const CATEGORY = "science";

/** What the picker calls the whole library. Not a collection, so it has no key. */
const ALL = "";

/**
 * Where to search.
 *
 * One live option, so no control.
 *
 * The general-web choice used to sit here greyed out, on the reasoning that a
 * capability the app supports should not be hidden just because no backend
 * ships. In use it reads as a broken control -- the only thing a permanently
 * disabled item teaches is that something is wrong -- and a select with a
 * single option is not a choice either. What both searching modes do is said
 * instead in the tooltip on the mode itself, which is where someone is already
 * looking when they decide how hard to search.
 */

export function ResearchBar({
  lookup,
  onLookup,
  onLeaveLookup,
  trailing,
}: {
  lookup: boolean;
  onLookup: () => void;
  onLeaveLookup: () => void;
  /**
   * Another control to sit in the same row as the rings.
   *
   * Taken as a child rather than placed beside this component in the composer,
   * because `mode-rings` is what wraps: anything outside it lands after a
   * two-row block and reads as belonging to the send button instead of to the
   * modes. The rings own the row, so what shares the row goes through here.
   */
  trailing?: React.ReactNode;
}) {
  /* Matches DEFAULT_RESEARCH in core/research/config.ts. The real value lands a
     tick later from getResearch(); starting at "off" would light the wrong
     button on every launch and then move it. */
  const [config, setConfig] = useState<ResearchConfig>({ mode: "assistant", category: "science" });

  useEffect(() => {
    void window.myra.getResearch().then(setConfig);
  }, []);

  const apply = (patch: Partial<ResearchConfig>): void => {
    const next = { ...config, category: CATEGORY, ...patch };
    setConfig(next);
    void window.myra.setResearch(next);
  };

  const rung = (m: Rung) => {
    const on = !lookup && config.mode === m.value;
    return (
      <button
        key={m.value}
        type="button"
        title={m.hint}
        aria-pressed={on}
        className={on ? "mode active" : "mode"}
        onClick={() => {
          onLeaveLookup();
          apply({ mode: m.value });
        }}
      >
        {m.label}
      </button>
    );
  };

  return (
    <div className="research-bar" data-tour="composer-research">
      <div className="mode-rings" role="group" aria-label="How to search">
        <div className="mode-ring" title={LOCAL_HINT}>
          <span className="mode-ring-label">Local</span>
          <div className="mode-ring-row" role="group" aria-label="Local: nothing leaves this machine">
            {LOCAL.map(rung)}
          </div>
        </div>

        <div className="mode-ring web" title={WEB_HINT}>
          {/* The databases, not the word "web".
            *
            * "Web" was doing two jobs badly: warning that these rungs leave the
            * machine -- which the buttons' own hint already says, and which the
            * privacy report says properly -- and describing what they search,
            * which is not the web. They search two scholarly indexes, and
            * naming them is the difference between "it looked online" and
            * something a researcher can judge the coverage of. */}
          <span className="mode-ring-label" title={`Searches ${databaseLabel(config.databases)}`}>
            {databaseLabel(config.databases)}
          </span>
          <div className="mode-ring-row" role="group" aria-label="Web: these reach the internet">
            {WEB.map(rung)}
            <button
              type="button"
              title={LOOKUP_HINT}
              aria-pressed={lookup}
              className={lookup ? "mode lookup active" : "mode lookup"}
              onClick={onLookup}
            >
              Look up
            </button>
          </div>
        </div>

        {trailing}
      </div>

      {/* At the Library rung only.
        *
        * It was shown wherever search_library is in the schema -- Library,
        * Quick and Deep -- reasoning that a scope in force must stay visible.
        * That was the right instinct about the wrong thing: Quick and Deep are
        * questions about the literature, and a Zotero collection picker sitting
        * under them says the two are one feature when they are not.
        *
        * So the SCOPE now belongs to the rung as well, not just its control:
        * see `collectionScope` in tools/library.ts. Nothing invisible is left
        * applying up there, which is the property that mattered. */}
      {exactly(config.mode, "library") && !lookup ? (
        <CollectionPicker
          chosen={config.collection ?? ALL}
          chosenName={config.collectionName ?? ""}
          onChoose={(key, name) =>
            apply(key ? { collection: key, collectionName: name } : { collection: undefined, collectionName: undefined })
          }
        />
      ) : null}

      {/* Shared by Quick, Deep and Look up -- all three search the literature,
          and it is one setting for what "the literature" means here, not
          three. Not shown at Off/Documents/Library: those rungs do not
          search databases at all. */}
      {(searches(config.mode) || lookup) && !exactly(config.mode, "library") ? (
        <DatabasePicker chosen={config.databases ?? []} onChoose={(databases) => apply({ databases })} />
      ) : null}
    </div>
  );
}

/**
 * Which databases Quick, Deep and Look up search.
 *
 * A database with no key is shown, disabled, rather than hidden -- the app
 * removed a permanently-disabled "general web" category once already because
 * a control nobody can ever use reads as broken, and the fix there was the
 * opposite of hiding it: it named what would fill the gap and where. This is
 * the same call, in the other direction, for a control that CAN be used, just
 * not yet.
 */
function DatabasePicker({
  chosen,
  onChoose,
}: {
  chosen: string[];
  onChoose: (ids: string[]) => void;
}) {
  const [present, setPresent] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void window.myra.secretsBackend().then((v) => setPresent(v.present ?? {}));
  }, []);

  const active = chosen.length ? chosen : [...DEFAULT_DATABASES];

  const toggle = (id: string, usable: boolean): void => {
    if (!usable) return;
    const on = active.includes(id);
    // Refused rather than silently falling back to the defaults: a control
    // that changes what it searches without being asked is exactly what the
    // Zotero picker's own stored-but-missing-collection handling exists to
    // avoid, in the other direction.
    if (on && active.length <= 1) return;
    onChoose(on ? active.filter((x) => x !== id) : [...active, id]);
  };

  return (
    <div className="database-ask">
      <span className="database-ask-label">Databases</span>
      {/* Built like a mode ring -- the same rounded pill row the rungs above
          use -- because this is the same family of control (a thing to
          switch on or off) even though it is not a privacy boundary and so
          borrows neither the local ring's green nor the web ring's amber. */}
      <div className="database-row" role="group" aria-label="Which databases to search">
        {DATABASES.map((d) => {
          const usable = !d.secret || Boolean(present[d.secret]);
          const on = active.includes(d.id) && usable;
          // The last ticked pill locks rather than merely refusing the
          // click -- a control that could be switched off down to nothing
          // should not look clickable at the moment it is not.
          const locked = on && active.length <= 1;
          return (
            <button
              key={d.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={locked}
              title={
                !usable
                  ? "Needs a free API key — click to get one, or add it in Settings → Database keys"
                  : locked
                    ? "At least one database must stay chosen"
                    : d.covers
              }
              className={usable ? (on ? "mode active" : "mode") : "mode needs-key"}
              onClick={() =>
                usable ? toggle(d.id, usable) : void window.myra.openExternal(d.signup ?? "")
              }
            >
              {d.label}
              {!usable ? (
                <span className="database-lock" aria-hidden="true">
                  🔒
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Which part of the library to search.
 *
 * Only on screen at the rung it applies to, because a scope with no search to
 * scope is a setting nobody can act on -- and because appearing when Library is
 * chosen is what makes it a question rather than a preference to go hunting for.
 *
 * The failures are shown, not swallowed. Zotero closed and Zotero's local API
 * switched off both produce an empty list, and an empty picker is
 * indistinguishable from a library that has no collections in it; only one of
 * those three is something the user can do nothing about.
 */
function CollectionPicker({
  chosen,
  chosenName,
  onChoose,
}: {
  chosen: string;
  chosenName: string;
  onChoose: (key: string, name: string) => void;
}) {
  const [state, setState] = useState<{
    loading: boolean;
    collections: CollectionNode[];
    error: string;
    via: "api" | "database";
  }>({ loading: true, collections: [], error: "", via: "api" });

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    void window.myra.zoteroCollections().then((res) => {
      setState({
        loading: false,
        collections: res.collections ?? [],
        error: res.ok ? "" : (res.error ?? "Zotero could not be reached."),
        via: res.via ?? "api",
      });
    });
  }, []);

  useEffect(load, [load]);

  /* A stored collection that Zotero no longer has. Kept as a real option rather
     than silently falling back to "All collections", because the difference
     between those two is the difference between searching one shelf and
     searching the room, and a control must not change that on its own. */
  const found = state.collections.find((c) => c.key === chosen);
  const missing = chosen && !found;
  /* Said out loud, because it is the one thing about the choice that is not
     visible in it: picking a parent reaches the collections underneath. */
  const below = found?.children ?? 0;

  if (state.error) {
    return (
      <div className="collection-ask unreachable">
        <span>{state.error}</span>
        <button type="button" className="btn-sm" onClick={load}>Try again</button>
      </div>
    );
  }

  return (
    <div className="collection-ask">
      <label
        htmlFor="zotero-collection"
        title="Only the collection you pick is searched when MyRA looks in your Zotero library. The rest of it is left alone. This does not affect web searching."
      >
        Which Zotero collection?
      </label>
      <select
        id="zotero-collection"
        className="select-sm"
        disabled={state.loading}
        value={chosen}
        onChange={(e) => {
          const key = e.target.value;
          const picked = state.collections.find((c) => c.key === key);
          onChoose(key, picked?.name ?? "");
        }}
      >
        <option value={ALL}>
          {state.loading ? "Loading collections…" : "All collections"}
        </option>
        {missing ? (
          <option value={chosen}>{chosenName || chosen} — no longer in Zotero</option>
        ) : null}
        {state.collections.map((c) => (
          /* Indented, not counted. The nesting is what a person needs while the
             list is open, and the reach of the one they picked is what they
             need once it is closed -- which the note beside the select says,
             rather than saying it twice. */
          <option key={c.key} value={c.key} title={c.path}>
            {"  ".repeat(c.depth)}
            {c.name}
          </option>
        ))}
      </select>
      {below > 0 ? (
        <span
          className="collection-note"
          title="Zotero's own search does not look inside subcollections. MyRA's does, or choosing a collection you file everything below would come back empty."
        >
          + {below} below it
        </span>
      ) : null}
      {/* Said where the searching is chosen, because it changes what a search
          can find. Not an error -- this is the library, working -- but the two
          routes do not look in the same places, and only this one misses the
          text inside PDFs. */}
      {state.via === "database" ? (
        <span
          className="collection-note reading-file"
          title="Zotero's local API did not answer — a Flatpak or Snap install keeps that port inside its own sandbox. MyRA is reading a read-only copy of zotero.sqlite instead. Titles, abstracts, authors, tags and notes are searched; the text inside PDFs is not."
        >
          reading the library file
        </span>
      ) : null}
    </div>
  );
}
