import { useCallback, useEffect, useReducer, useRef } from 'react';

import { searchLiveVenues } from './liveDirectory';
import { initialResults, resultsReducer } from './resultsState';
import { filterKey, searchKey, type DiscoveryQuery } from './searchClient';

/** Live T13 results for one query; a new query aborts and supersedes earlier pages. */
export function useVenueSearch(query: DiscoveryQuery) {
  const [state, dispatch] = useReducer(resultsReducer, initialResults);
  const latest = useRef({ query, state });
  const controller = useRef<AbortController | null>(null);
  const requests = useRef(0);
  const key = searchKey(query);

  // Declared before the search effect so a new query is visible to run() in the same commit.
  useEffect(() => { latest.current = { query, state }; });

  const run = useCallback(async (after: string | null) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestId = ++requests.current;
    const append = after !== null;
    dispatch(append ? { type: 'more', requestId } : { type: 'search', requestId, filterKey: filterKey(latest.current.query) });
    try {
      const outcome = await searchLiveVenues(latest.current.query, after, abort.signal);
      if (abort.signal.aborted) return;
      dispatch(outcome.ok
        ? { type: 'loaded', requestId, venues: outcome.page.venues, nextCursor: outcome.page.next_cursor, append }
        : { type: 'failed', requestId, failure: outcome.failure, append });
    } catch {
      if (!abort.signal.aborted) dispatch({ type: 'failed', requestId, failure: { kind: 'network', retryAfterSeconds: null }, append });
    }
  }, []);

  useEffect(() => {
    void run(null);
    return () => controller.current?.abort();
  }, [key, run]);

  const loadMore = useCallback(() => {
    const current = latest.current.state;
    if (current.status === 'ready' && current.nextCursor && !current.loadingMore) void run(current.nextCursor);
  }, [run]);

  const retry = useCallback(() => {
    const current = latest.current.state;
    if (current.status === 'ready' && current.failure && current.nextCursor) void run(current.nextCursor);
    else void run(null);
  }, [run]);

  const remove = useCallback((id: string) => dispatch({ type: 'remove', id }), []);

  return { results: state, loadMore, retry, remove };
}
