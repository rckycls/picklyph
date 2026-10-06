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
};

export type ResultsAction =
  | { type: 'search'; requestId: number; filterKey: string }
  | { type: 'more'; requestId: number }
  | { type: 'loaded'; requestId: number; venues: VenueSearchItem[]; nextCursor: string | null; append: boolean }
  | { type: 'failed'; requestId: number; failure: SearchFailure; append: boolean }
  | { type: 'remove'; id: string };

export const initialResults: ResultsState = {
  status: 'loading', requestId: 0, filterKey: null, venues: [], nextCursor: null, loadingMore: false, failure: null, capped: false,
};

export function resultsReducer(state: ResultsState, action: ResultsAction): ResultsState {
  switch (action.type) {
    case 'search': {
      // Panning keeps markers visible until the new area loads; changed filters never show non-matching venues.
      const sameFilters = action.filterKey === state.filterKey && state.status !== 'error';
      return {
        status: 'loading', requestId: action.requestId, filterKey: action.filterKey,
        venues: sameFilters ? state.venues : [], nextCursor: null, loadingMore: false, failure: null, capped: false,
      };
    }
    case 'more':
      if (state.status !== 'ready' || !state.nextCursor || state.loadingMore) return state;
      return { ...state, requestId: action.requestId, loadingMore: true, failure: null };
    case 'loaded': {
      if (action.requestId !== state.requestId) return state;
      const base = action.append ? state.venues : [];
      const seen = new Set(base.map((venue) => venue.id));
      const merged = [...base, ...action.venues.filter((venue) => !seen.has(venue.id) && seen.add(venue.id))];
      const capped = merged.length >= MAX_LOADED_VENUES && (action.nextCursor !== null || merged.length > MAX_LOADED_VENUES);
      return {
        ...state, status: 'ready', venues: merged.slice(0, MAX_LOADED_VENUES), loadingMore: false, failure: null,
        nextCursor: capped ? null : action.nextCursor, capped,
      };
    }
    case 'failed':
      if (action.requestId !== state.requestId) return state;
      if (action.append) return { ...state, loadingMore: false, failure: action.failure };
      return { ...state, status: 'error', venues: [], nextCursor: null, loadingMore: false, failure: action.failure, capped: false };
    case 'remove':
      return { ...state, venues: state.venues.filter((venue) => venue.id !== action.id) };
  }
}
