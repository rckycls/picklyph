import type { VenueSearchItem } from '@picklyph/domain';

import type { SearchFailure } from './searchClient';

/** Bounds memory and map markers; the player zooms in rather than paging indefinitely. */
export const MAX_LOADED_VENUES = 200;

export type ResultsState = {
  status: 'loading' | 'ready' | 'error';
  /** Only the latest request may change results; superseded responses are ignored. */
  requestId: number;
  filterKey: string | null;
  venues: VenueSearchItem[];
  nextCursor: string | null;
  loadingMore: boolean;
  /** Search failure while status is error; load-more failure while status is ready. */
  failure: SearchFailure | null;
  capped: boolean;
  /** Earliest retry time (epoch ms) from the server's Retry-After; null when a retry may run now. */
  retryAt: number | null;
};

export type ResultsAction =
  | { type: 'search'; requestId: number; filterKey: string }
  | { type: 'more'; requestId: number }
  | { type: 'loaded'; requestId: number; venues: VenueSearchItem[]; nextCursor: string | null; append: boolean }
  | { type: 'failed'; requestId: number; failure: SearchFailure; append: boolean; at: number }
  | { type: 'remove'; id: string };

export const initialResults: ResultsState = {
  status: 'loading', requestId: 0, filterKey: null, venues: [], nextCursor: null, loadingMore: false, failure: null, capped: false, retryAt: null,
};

const retryAt = (failure: SearchFailure, at: number) => (failure.retryAfterSeconds === null ? null : at + failure.retryAfterSeconds * 1000);

export function resultsReducer(state: ResultsState, action: ResultsAction): ResultsState {
  switch (action.type) {
    case 'search': {
      // Panning keeps markers visible until the new area loads; changed filters never show non-matching venues.
      const sameFilters = action.filterKey === state.filterKey && state.status !== 'error';
      return {
        status: 'loading', requestId: action.requestId, filterKey: action.filterKey,
        venues: sameFilters ? state.venues : [], nextCursor: null, loadingMore: false, failure: null, capped: false, retryAt: null,
      };
    }
    case 'more':
      if (state.status !== 'ready' || !state.nextCursor || state.loadingMore) return state;
      return { ...state, requestId: action.requestId, loadingMore: true, failure: null, retryAt: null };
    case 'loaded': {
      if (action.requestId !== state.requestId) return state;
      const base = action.append ? state.venues : [];
      const seen = new Set(base.map((venue) => venue.id));
      const merged = [...base, ...action.venues.filter((venue) => !seen.has(venue.id) && seen.add(venue.id))];
      const capped = merged.length >= MAX_LOADED_VENUES && (action.nextCursor !== null || merged.length > MAX_LOADED_VENUES);
      return {
        ...state, status: 'ready', venues: merged.slice(0, MAX_LOADED_VENUES), loadingMore: false, failure: null, retryAt: null,
        nextCursor: capped ? null : action.nextCursor, capped,
      };
    }
    case 'failed':
      if (action.requestId !== state.requestId) return state;
      // Loaded venues stay after a load-more failure; a failed search shows no earlier area's results.
      if (action.append) return { ...state, loadingMore: false, failure: action.failure, retryAt: retryAt(action.failure, action.at) };
      return { ...state, status: 'error', venues: [], nextCursor: null, loadingMore: false, failure: action.failure, capped: false, retryAt: retryAt(action.failure, action.at) };
    case 'remove':
      return { ...state, venues: state.venues.filter((venue) => venue.id !== action.id) };
  }
}
