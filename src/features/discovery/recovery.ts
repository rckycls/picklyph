// Type-only imports keep this module loadable by the Node tests.
import type { ResultsState } from './resultsState';
import type { DiscoveryFilters } from './searchClient';

export type Recovery = {
  /** Retrying can help: offline, rate limited or temporarily unavailable. */
  retryable: boolean;
  /** Whole seconds until the server will accept a retry; 0 means now. */
  waitSeconds: number;
  /** A failed search with a server-supplied wait retries itself once when the wait ends. */
  automatic: boolean;
};

/** What a failed search or page may offer. Null when nothing failed. */
export function recoveryFor(state: Pick<ResultsState, 'status' | 'failure' | 'retryAt'>, now: number): Recovery | null {
  const { failure } = state;
  if (!failure) return null;
  const retryable = failure.kind === 'network' || failure.kind === 'rate_limited' || failure.kind === 'unavailable';
  const waitSeconds = retryable && state.retryAt !== null ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : 0;
  return { retryable, waitSeconds, automatic: retryable && state.status === 'error' && state.retryAt !== null };
}

export function retryLabel(recovery: Recovery): string {
  if (recovery.waitSeconds <= 0) return 'Try again';
  return recovery.waitSeconds > 90 ? `Try again in ${Math.ceil(recovery.waitSeconds / 60)} min` : `Try again in ${recovery.waitSeconds}s`;
}

export function filtersActive(filters: DiscoveryFilters): boolean {
  return activeFilterCount(filters) > 0;
}

/** How many filter groups are narrowing the search, for the Filters button's badge. */
export function activeFilterCount(filters: DiscoveryFilters): number {
  return [filters.indoor, filters.covered, filters.surface].filter((value) => value !== null).length;
}

/**
 * Empty results and rejected searches are fixed by widening the search, not by retrying it.
 * Only offers actions that would change the next query.
 */
export function wideningActions(state: Pick<ResultsState, 'status' | 'failure' | 'venues'>, options: { filtersActive: boolean; national: boolean }) {
  const applies = state.status === 'error' ? state.failure?.kind === 'rejected' : state.status === 'ready' && state.venues.length === 0;
  return { clearFilters: applies && options.filtersActive, zoomOut: applies && !options.national };
}
