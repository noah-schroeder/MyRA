import { useCallback, useMemo, useRef, useState } from "react";
import type { AcademicResult, SortBy } from "./types.ts";

/**
 * Academic search you drive yourself.
 *
 * The same APIs the research pipeline uses, with no model in the loop — because
 * wanting to look something up is not the same as wanting to talk to a language
 * model about it. For a straight lookup the model is pure overhead: slower, and
 * able to paraphrase a title.
 *
 * The state lives here rather than in the results view because the box you type
 * the query into is the composer, several elements away: the search is a mode
 * of the app, not a widget.
 */
export interface LookupState {
  /** The query these results answer — not what is currently in the box. */
  query: string;
  page: number;
  sort: SortBy;
  results: AcademicResult[];
  failures: string[];
  busy: boolean;
  error?: string | undefined;
}

const EMPTY: LookupState = {
  query: "",
  page: 1,
  sort: "relevance",
  results: [],
  failures: [],
  busy: false,
};

export interface Lookup {
  state: LookupState;
  run: (query: string) => Promise<void>;
  setSort: (sort: SortBy) => void;
  goToPage: (page: number) => Promise<void>;
}

export function useLookup(): Lookup {
  const [state, setState] = useState<LookupState>(EMPTY);
  const seq = useRef(0);

  const fetchPage = useCallback(
    async (query: string, page: number, sort: SortBy): Promise<void> => {
      if (!query.trim()) return;
      const ticket = ++seq.current;
      setState((s) => ({ ...s, query, page, sort, busy: true, error: undefined }));
      try {
        const found = await window.karen.academicSearch(query, { page, sort });
        if (ticket !== seq.current) return;
        setState((s) => ({ ...s, results: found.results, failures: found.failures, busy: false }));
      } catch (e) {
        if (ticket !== seq.current) return;
        setState((s) => ({ ...s, results: [], failures: [], busy: false, error: (e as Error).message }));
      }
    },
    [],
  );

  const run = useCallback(
    (query: string) => fetchPage(query, 1, state.sort),
    [fetchPage, state.sort],
  );

  // Sorting reorders what is already here, so it must not change the query: a
  // different query would make the paper you were reading disappear.
  const setSort = useCallback(
    (sort: SortBy) => {
      if (!state.query) {
        setState((s) => ({ ...s, sort }));
        return;
      }
      void fetchPage(state.query, state.page, sort);
    },
    [fetchPage, state.query, state.page],
  );

  const goToPage = useCallback(
    (page: number) => fetchPage(state.query, page, state.sort),
    [fetchPage, state.query, state.sort],
  );

  return useMemo(() => ({ state, run, setSort, goToPage }), [state, run, setSort, goToPage]);
}
