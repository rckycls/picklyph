import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { searchLiveVenues } from './liveDirectory';
import { recoveryFor } from './recovery';
import { initialResults, resultsReducer } from './resultsState';
import { filterKey, searchKey, type DiscoveryQuery } from './searchClient';

/** Live T13 results for one query; a new query aborts and supersedes earlier pages. */
export function useVenueSearch(query: DiscoveryQuery) {
  const [state, dispatch] = useReducer(resultsReducer, initialResults);
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef({ query, state });
  const controller = useRef<AbortController | null>(null);
  const requests = useRef(0);
  // At most one automatic retry per failure streak; the player decides after that.
  const autoRetried = useRef(false);
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
      if (outcome.ok) autoRetried.current = false;
      dispatch(outcome.ok
        ? { type: 'loaded', requestId, venues: outcome.page.venues, nextCursor: outcome.page.next_cursor, append }
        : { type: 'failed', requestId, failure: outcome.failure, append, at: Date.now() });
    } catch {
      if (!abort.signal.aborted) dispatch({ type: 'failed', requestId, failure: { kind: 'network', retryAfterSeconds: null }, append, at: Date.now() });
    }
  }, []);

  useEffect(() => {
    autoRetried.current = false;
    void run(null);
    return () => controller.current?.abort();
  }, [key, run]);

  // Tick only while a server-requested wait is running (countdown and automatic retry).
  useEffect(() => {
    if (state.retryAt === null) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [state.retryAt]);

  const recovery = recoveryFor(state, now);
  const automaticDue = Boolean(recovery?.automatic && recovery.waitSeconds === 0);
  useEffect(() => {
    if (!automaticDue || autoRetried.current) return;
    autoRetried.current = true;
    void run(null);
  }, [automaticDue, run]);

  // Offline searches recover when the player returns to the app; no background polling.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const current = latest.current.state;
      if (next === 'active' && current.status === 'error' && current.failure?.kind === 'network') void run(null);
    });
    return () => subscription.remove();
  }, [run]);

  const loadMore = useCallback(() => {
    const current = latest.current.state;
    if (current.status === 'ready' && current.nextCursor && !current.loadingMore) void run(current.nextCursor);
  }, [run]);

  const retry = useCallback(() => {
    const current = latest.current.state;
    // The button is disabled during a server-requested wait; ignore any stray press.
    if (current.retryAt !== null && current.retryAt > Date.now()) return;
    autoRetried.current = false;
    if (current.status === 'ready' && current.failure && current.nextCursor) void run(current.nextCursor);
    else void run(null);
  }, [run]);

  const remove = useCallback((id: string) => dispatch({ type: 'remove', id }), []);

  return { results: state, recovery, loadMore, retry, remove };
}
