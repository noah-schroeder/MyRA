import { useCallback, useEffect, useState } from "react";
import { readsLibrary, searches } from "../types.ts";
import type { CollectionNode, ResearchConfig, ResearchMode } from "../types.ts";

/**
 * One control for the whole question of how far Karen may reach.
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
 * thing a person needs to predict is what Karen might do without being asked.
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
  { value: "library", label: "Library", hint: "The model can also search your own Zotero library — your collected papers, on this machine. Still no network, and Zotero must be open." },
];

const WEB: Rung[] = [
  { value: "web", label: "Quick", hint: "The model searches OpenAlex and arXiv, and cites what it used. Seconds." },
  { value: "deep", label: "Deep", hint: "Plan, search, read, verify and synthesise a cited report. Minutes." },
];

const LOCAL_HINT = "Nothing leaves this machine in these three. Zotero answers on loopback, so a library search is no more of an egress than opening a file.";
const WEB_HINT = "These reach the internet: OpenAlex, arXiv, and the pages they point at.";
const LOOKUP_HINT = "Search OpenAlex and arXiv yourself. No model, no waiting, nothing logged.";

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
}: {
  lookup: boolean;
  onLookup: () => void;
  onLeaveLookup: () => void;
}) {
  /* Matches DEFAULT_RESEARCH in core/research/config.ts. The real value lands a
     tick later from getResearch(); starting at "off" would light the wrong
     button on every launch and then move it. */
  const [config, setConfig] = useState<ResearchConfig>({ mode: "assistant", category: "science" });

  useEffect(() => {
    void window.karen.getResearch().then(setConfig);
  }, []);

  const apply = (patch: Partial<ResearchConfig>): void => {
    const next = { ...config, category: CATEGORY, ...patch };
    setConfig(next);
    void window.karen.setResearch(next);
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
    <div className="research-bar">
      <div className="mode-rings" role="group" aria-label="How to search">
        <div className="mode-ring" title={LOCAL_HINT}>
          <span className="mode-ring-label">Local</span>
          <div className="mode-ring-row" role="group" aria-label="Local: nothing leaves this machine">
            {LOCAL.map(rung)}
          </div>
        </div>

        <div className="mode-ring web" title={WEB_HINT}>
          <span className="mode-ring-label">Web</span>
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
      </div>

      {readsLibrary(config.mode) && !lookup ? (
        <CollectionPicker
          /* Whether an unreachable Zotero is worth saying out loud.
           *
           * At "Library" it is the point of the rung: the user picked the one
           * setting whose entire job is the library, and silence would leave
           * them waiting on a search that cannot happen. At "Quick" and "Deep"
           * they asked about the literature and the library is a bonus, so a
           * standing warning about a program they may not even have open is
           * just something in the way of the composer. The picker still appears
           * up there when Zotero IS answering, because the scope applies at
           * those rungs and a live scope has to stay visible. */
          announceFailure={!searches(config.mode)}
          chosen={config.collection ?? ALL}
          chosenName={config.collectionName ?? ""}
          onChoose={(key, name) =>
            apply(key ? { collection: key, collectionName: name } : { collection: undefined, collectionName: undefined })
          }
        />
      ) : null}
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
  announceFailure,
  chosen,
  chosenName,
  onChoose,
}: {
  announceFailure: boolean;
  chosen: string;
  chosenName: string;
  onChoose: (key: string, name: string) => void;
}) {
  const [state, setState] = useState<{
    loading: boolean;
    collections: CollectionNode[];
    error: string;
  }>({ loading: true, collections: [], error: "" });

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    void window.karen.zoteroCollections().then((res) => {
      setState({
        loading: false,
        collections: res.collections ?? [],
        error: res.ok ? "" : (res.error ?? "Zotero could not be reached."),
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

  /* Nothing at all, rather than a quieter warning: at a searching rung this is
     news about a program the user did not ask Karen to use this turn. */
  if (state.error && !announceFailure) return null;

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
        title="Only the collection you pick is searched when Karen looks in your Zotero library. The rest of it is left alone. This does not affect web searching."
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
          title="Zotero's own search does not look inside subcollections. Karen's does, or choosing a collection you file everything below would come back empty."
        >
          + {below} below it
        </span>
      ) : null}
    </div>
  );
}
