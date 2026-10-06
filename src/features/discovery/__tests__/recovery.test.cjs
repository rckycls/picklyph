const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initialResults, resultsReducer } = require('../resultsState.ts');
const { filtersActive, locationMessage, recoveryFor, retryLabel, wideningActions } = require('../recovery.ts');
const { failureMessage, resultsSummary } = require('../listing.ts');
const { NO_FILTERS } = require('../searchClient.ts');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venue = (n) => ({ id: id(n), name: `Venue ${n}`, address_line: 'Address', city: 'Manila', province: 'Metro Manila', country_code: 'PH',
  latitude: 14.6, longitude: 121, claim_status: 'unclaimed', active_court_count: 2 });
const searching = () => resultsReducer(initialResults, { type: 'search', requestId: 1, filterKey: 'a' });
const failed = (failure, at = 10_000) => resultsReducer(searching(), { type: 'failed', requestId: 1, failure, append: false, at });
const loaded = (venues, nextCursor = null) => resultsReducer(searching(), { type: 'loaded', requestId: 1, venues, nextCursor, append: false });

test('server waits become a retry deadline that every new request clears', () => {
  const limited = failed({ kind: 'rate_limited', retryAfterSeconds: 7 });
  assert.equal(limited.retryAt, 17_000); assert.equal(limited.venues.length, 0, 'no earlier area shown beside an error');
  assert.equal(failed({ kind: 'network', retryAfterSeconds: null }).retryAt, null);
  assert.equal(resultsReducer(limited, { type: 'search', requestId: 2, filterKey: 'a' }).retryAt, null);
  const page = loaded([venue(1)], id(1));
  const more = resultsReducer(resultsReducer(page, { type: 'more', requestId: 2 }), { type: 'failed', requestId: 2, failure: { kind: 'unavailable', retryAfterSeconds: 5 }, append: true, at: 1_000 });
  assert.equal(more.retryAt, 6_000); assert.equal(more.venues.length, 1, 'loaded venues stay after a page failure');
  assert.equal(resultsReducer(more, { type: 'more', requestId: 3 }).retryAt, null);
});

test('recovery offers retry only where it helps, with a countdown and one automatic search after server waits', () => {
  const limited = failed({ kind: 'rate_limited', retryAfterSeconds: 7 });
  assert.deepEqual(recoveryFor(limited, 10_000), { retryable: true, waitSeconds: 7, automatic: true });
  assert.deepEqual(recoveryFor(limited, 16_100), { retryable: true, waitSeconds: 1, automatic: true });
  assert.deepEqual(recoveryFor(limited, 30_000), { retryable: true, waitSeconds: 0, automatic: true });
  assert.deepEqual(recoveryFor(failed({ kind: 'unavailable', retryAfterSeconds: 5 }), 10_000), { retryable: true, waitSeconds: 5, automatic: true });
  assert.deepEqual(recoveryFor(failed({ kind: 'unavailable', retryAfterSeconds: null }), 10_000), { retryable: true, waitSeconds: 0, automatic: false });
  assert.deepEqual(recoveryFor(failed({ kind: 'network', retryAfterSeconds: null }), 10_000), { retryable: true, waitSeconds: 0, automatic: false },
    'offline waits for the player or the app returning to the foreground');
  for (const kind of ['rejected', 'not_configured']) {
    assert.deepEqual(recoveryFor(failed({ kind, retryAfterSeconds: null }), 10_000), { retryable: false, waitSeconds: 0, automatic: false });
  }
  const page = loaded([venue(1)], id(1));
  const more = resultsReducer(resultsReducer(page, { type: 'more', requestId: 2 }), { type: 'failed', requestId: 2, failure: { kind: 'rate_limited', retryAfterSeconds: 3 }, append: true, at: 0 });
  assert.deepEqual(recoveryFor(more, 0), { retryable: true, waitSeconds: 3, automatic: false }, 'paging resumes only when the player asks');
  assert.equal(recoveryFor(page, 0), null);
  assert.equal(retryLabel({ retryable: true, waitSeconds: 0, automatic: false }), 'Try again');
  assert.equal(retryLabel({ retryable: true, waitSeconds: 7, automatic: true }), 'Try again in 7s');
  assert.equal(retryLabel({ retryable: true, waitSeconds: 120, automatic: true }), 'Try again in 2 min');
});

test('empty and rejected searches offer only actions that change the next query', () => {
  const empty = loaded([]);
  assert.deepEqual(wideningActions(empty, { filtersActive: true, national: false }), { clearFilters: true, zoomOut: true });
  assert.deepEqual(wideningActions(empty, { filtersActive: false, national: true }), { clearFilters: false, zoomOut: false });
  assert.deepEqual(wideningActions(failed({ kind: 'rejected', retryAfterSeconds: null }), { filtersActive: true, national: false }), { clearFilters: true, zoomOut: true });
  for (const state of [searching(), loaded([venue(1)]), failed({ kind: 'network', retryAfterSeconds: null })]) {
    assert.deepEqual(wideningActions(state, { filtersActive: true, national: false }), { clearFilters: false, zoomOut: false });
  }
  assert.equal(filtersActive(NO_FILTERS), false);
  assert.equal(filtersActive({ ...NO_FILTERS, covered: false }), true);
});

test('loading, empty and failure copy stays truthful: no availability or booking claims, no retry promise for rejected input', () => {
  const states = [searching(), loaded([]), loaded([venue(1)], id(1)), resultsReducer(loaded([venue(1)]), { type: 'search', requestId: 2, filterKey: 'a' }),
    ...['network', 'rate_limited', 'unavailable', 'rejected', 'not_configured'].map((kind) => failed({ kind, retryAfterSeconds: kind === 'rate_limited' ? 4 : null }))];
  for (const state of states) {
    const text = resultsSummary(state);
    assert.ok(text.length > 15); assert.doesNotMatch(text, /\bbook|open now|free court|slots?\b/i, text);
  }
  assert.match(resultsSummary(searching()), /Searching approved venues/);
  assert.match(resultsSummary(resultsReducer(loaded([venue(1)]), { type: 'search', requestId: 2, filterKey: 'a' })), /Updating/);
  assert.doesNotMatch(failureMessage({ kind: 'rejected', retryAfterSeconds: null }), /try again/i);
  assert.match(failureMessage({ kind: 'network', retryAfterSeconds: null }), /connection/);
});

test('every location state keeps discovery usable and explains what to do', () => {
  const messages = [{ status: 'idle' }, { status: 'requesting' }, { status: 'granted' }, { status: 'denied', canAskAgain: true },
    { status: 'denied', canAskAgain: false }, { status: 'disabled' }, { status: 'unavailable' }].map((location) => locationMessage(location, false));
  assert.equal(new Set(messages).size, messages.length);
  for (const [index, text] of messages.entries()) {
    if (index >= 3) assert.match(text, /explor|brows/i, `${text} keeps the directory usable`);
  }
  assert.match(locationMessage({ status: 'denied', canAskAgain: false }, false), /Settings/);
  assert.match(locationMessage({ status: 'granted' }, true), /Couldn’t open Settings/);
});
