const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readVenueSearch } = require('../../../../packages/domain/src/search.ts');
const { NO_FILTERS, filterKey, parseSearchPage, searchKey, searchParams, searchVenues } = require('../searchClient.ts');
const { PHILIPPINES_REGION, regionToBounds, sameBounds, venueRegion } = require('../region.ts');
const { MAX_LOADED_VENUES, initialResults, resultsReducer } = require('../resultsState.ts');
const { courtSummary, directionsLinks, failureMessage, listingNotice, markerDescription, resultsSummary } = require('../listing.ts');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venue = (n, extra = {}) => ({
  id: id(n), name: `Venue ${n}`, address_line: 'Address', city: 'Manila', province: 'Metro Manila', country_code: 'PH',
  latitude: 14.6, longitude: 121, claim_status: 'unclaimed', active_court_count: 2, ...extra,
});
const national = regionToBounds(PHILIPPINES_REGION);

test('map regions become valid T13 bounds, including oversized and invalid camera values', () => {
  assert.deepEqual(national, { south: 3.3, west: 115.3, north: 22.3, east: 128.3 });
  assert.equal(readVenueSearch(searchParams({ ...NO_FILTERS, bounds: national })).bounds.north, 22.3);
  const wide = regionToBounds({ latitude: 12, longitude: 122, latitudeDelta: 80, longitudeDelta: 200 });
  assert.ok(wide.north - wide.south <= 30 && wide.east - wide.west <= 30, 'Spans are capped at the API maximum');
  assert.doesNotThrow(() => readVenueSearch(searchParams({ ...NO_FILTERS, bounds: wide })));
  const edge = regionToBounds({ latitude: 89.9, longitude: 179.9, latitudeDelta: 2, longitudeDelta: 2 });
  assert.equal(edge.north, 90); assert.equal(edge.east, 180);
  assert.doesNotThrow(() => readVenueSearch(searchParams({ ...NO_FILTERS, bounds: edge })));
  assert.equal(regionToBounds({ latitude: Number.NaN, longitude: 121, latitudeDelta: 1, longitudeDelta: 1 }), null);
  assert.ok(sameBounds(national, { ...national }));
  assert.deepEqual(venueRegion(venue(1)), { latitude: 14.6, longitude: 121, latitudeDelta: 0.04, longitudeDelta: 0.04 });
});

test('client parameters satisfy the shared server parser and keep cursor out of query identity', () => {
  const query = { bounds: { south: 14.1234, west: 120.5, north: 14.9, east: 121.25 }, indoor: false, covered: true, surface: 'synthetic' };
  const parsed = readVenueSearch(searchParams(query, id(9), 25));
  assert.deepEqual(parsed, { bounds: query.bounds, city: null, name: null, indoor: false, covered: true, surface: 'synthetic', after: id(9), limit: 25 });
  assert.equal(searchKey(query), searchKey({ ...query }));
  assert.ok(!searchKey(query).includes('after'));
  assert.notEqual(searchKey(query), searchKey({ ...query, covered: null }));
  assert.equal(filterKey(query), filterKey({ ...query, bounds: national }), 'Bounds do not change filter identity');
  assert.equal(searchParams({ ...NO_FILTERS, bounds: national }).has('indoor'), false, 'Unset filters are omitted');
});

test('responses are strictly validated before any listing is shown', () => {
  const page = parseSearchPage({ venues: [venue(1, { id: id(1).toUpperCase() })], next_cursor: id(2).toUpperCase() });
  assert.equal(page.venues[0].id, id(1)); assert.equal(page.next_cursor, id(2));
  assert.deepEqual(Object.keys(page.venues[0]).sort(), Object.keys(venue(1)).sort(), 'Only approved public fields are kept');
  const extra = parseSearchPage({ venues: [{ ...venue(1), evidence_path: 'secret' }], next_cursor: null });
  assert.equal('evidence_path' in extra.venues[0], false);
  for (const bad of [
    null, [], { venues: [] }, { venues: [], next_cursor: 'nope' }, { venues: {}, next_cursor: null },
    { venues: Array.from({ length: 51 }, (_, n) => venue(n)), next_cursor: null },
    { venues: [venue(1, { id: 'x' })], next_cursor: null },
    { venues: [venue(1, { claim_status: 'bookable' })], next_cursor: null },
    { venues: [venue(1, { active_court_count: -1 })], next_cursor: null },
    { venues: [venue(1, { active_court_count: 1.5 })], next_cursor: null },
    { venues: [venue(1, { latitude: 91 })], next_cursor: null },
    { venues: [venue(1, { country_code: 'US' })], next_cursor: null },
    { venues: [venue(1, { name: '' })], next_cursor: null },
  ]) assert.throws(() => parseSearchPage(bad), /Unexpected directory response/);
});

function transport(responses, token = null) {
  const calls = [];
  return {
    calls,
    endpoint: 'https://example.test/functions/v1/venue-search',
    apiKey: 'public-key',
    accessToken: typeof token === 'function' ? token : async () => token,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const query = { ...NO_FILTERS, bounds: national };

test('guests send only the public key; signed-in players add their own bearer', async () => {
  const guest = transport([json(200, { venues: [venue(1)], next_cursor: null })]);
  const result = await searchVenues(guest, query);
  assert.equal(result.ok, true); assert.equal(result.page.venues.length, 1);
  assert.equal(guest.calls[0].init.method, 'GET');
  assert.equal(guest.calls[0].init.headers.apikey, 'public-key');
  assert.equal('Authorization' in guest.calls[0].init.headers, false, 'No SDK fallback bearer for guests');
  assert.ok(guest.calls[0].url.startsWith('https://example.test/functions/v1/venue-search?south=3.3000'));
  const player = transport([json(200, { venues: [], next_cursor: null })], 'user-token');
  await searchVenues(player, query, { after: id(3) });
  assert.equal(player.calls[0].init.headers.Authorization, 'Bearer user-token');
  assert.equal(new URL(player.calls[0].url).searchParams.get('after'), id(3));
});

test('a rejected stale token retries once as a guest, and token lookup failure stays guest', async () => {
  const stale = transport([json(401, { error: 'invalid_auth' }), json(200, { venues: [venue(1)], next_cursor: null })], 'expired');
  assert.equal((await searchVenues(stale, query)).ok, true);
  assert.equal(stale.calls.length, 2);
  assert.equal('Authorization' in stale.calls[1].init.headers, false);
  const broken = transport([json(200, { venues: [], next_cursor: null })], async () => { throw new Error('storage'); });
  assert.equal((await searchVenues(broken, query)).ok, true);
  assert.equal('Authorization' in broken.calls[0].init.headers, false);
});

test('rate limits, outages, rejections, network and malformed bodies map to recoverable failures', async () => {
  const outcome = async (response) => (await searchVenues(transport([response]), query)).failure;
  assert.deepEqual(await outcome(json(429, { error: 'rate_limited' }, { 'retry-after': '7' })), { kind: 'rate_limited', retryAfterSeconds: 7 });
  assert.deepEqual(await outcome(json(429, { error: 'rate_limited' })), { kind: 'rate_limited', retryAfterSeconds: 1 });
  assert.deepEqual(await outcome(json(503, { error: 'search_unavailable' }, { 'retry-after': '5' })), { kind: 'unavailable', retryAfterSeconds: 5 });
  assert.deepEqual(await outcome(json(404, { error: 'missing' })), { kind: 'unavailable', retryAfterSeconds: null });
  assert.deepEqual(await outcome(json(400, { error: 'invalid_search' })), { kind: 'rejected', retryAfterSeconds: null });
  assert.deepEqual(await outcome(new TypeError('Network request failed')), { kind: 'network', retryAfterSeconds: null });
  assert.deepEqual(await outcome(new Response('<html>', { status: 200 })), { kind: 'unavailable', retryAfterSeconds: null });
  assert.deepEqual(await outcome(json(200, { venues: [venue(1, { claim_status: 'open' })], next_cursor: null })), { kind: 'unavailable', retryAfterSeconds: null });
  for (const failure of [{ kind: 'rate_limited', retryAfterSeconds: 7 }, { kind: 'network', retryAfterSeconds: null }, { kind: 'unavailable', retryAfterSeconds: null }]) {
    assert.ok(failureMessage(failure).length > 20);
  }
  assert.match(failureMessage({ kind: 'rate_limited', retryAfterSeconds: 7 }), /7 seconds/);
});

test('superseded searches reject instead of producing a result', async () => {
  const abort = new AbortController();
  const slow = transport([]);
  slow.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const pending = searchVenues(slow, query, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending);
  const early = new AbortController(); early.abort();
  const unused = transport([]);
  await assert.rejects(searchVenues(unused, query, { signal: early.signal }));
  assert.equal(unused.calls.length, 0);
});

test('paging replaces, appends, de-duplicates, caps and ignores stale responses', () => {
  let state = resultsReducer(initialResults, { type: 'search', requestId: 1, filterKey: 'a' });
  assert.equal(state.status, 'loading');
  assert.equal(resultsReducer(state, { type: 'loaded', requestId: 0, venues: [venue(9)], nextCursor: null, append: false }), state, 'Stale page ignored');
  state = resultsReducer(state, { type: 'loaded', requestId: 1, venues: [venue(1), venue(2)], nextCursor: id(2), append: false });
  assert.deepEqual(state.venues.map((v) => v.id), [id(1), id(2)]);
  state = resultsReducer(state, { type: 'more', requestId: 2 });
  assert.equal(state.loadingMore, true);
  assert.equal(resultsReducer(state, { type: 'more', requestId: 3 }), state, 'One page request at a time');
  state = resultsReducer(state, { type: 'loaded', requestId: 2, venues: [venue(2), venue(3)], nextCursor: null, append: true });
  assert.deepEqual(state.venues.map((v) => v.id), [id(1), id(2), id(3)]);
  assert.equal(state.nextCursor, null); assert.equal(state.loadingMore, false);

  const panned = resultsReducer(state, { type: 'search', requestId: 4, filterKey: 'a' });
  assert.equal(panned.venues.length, 3, 'Same filters keep markers while the new area loads');
  assert.equal(panned.nextCursor, null);
  const filtered = resultsReducer(state, { type: 'search', requestId: 4, filterKey: 'b' });
  assert.equal(filtered.venues.length, 0, 'Changed filters never show non-matching venues');
  assert.equal(resultsReducer(filtered, { type: 'more', requestId: 5 }), filtered, 'No paging while loading');

  let big = resultsReducer(initialResults, { type: 'search', requestId: 1, filterKey: 'a' });
  for (let page = 0; page < 5; page++) {
    const venues = Array.from({ length: 50 }, (_, n) => venue(page * 50 + n));
    if (page > 0) big = resultsReducer(big, { type: 'more', requestId: page + 1 });
    big = resultsReducer(big, { type: 'loaded', requestId: page + 1, venues, nextCursor: id(9999), append: page > 0 });
  }
  assert.equal(big.venues.length, MAX_LOADED_VENUES); assert.equal(big.capped, true); assert.equal(big.nextCursor, null);
  assert.match(resultsSummary(big), /first 200; zoom in/);
});

test('failures clear search results but keep loaded pages when only load-more fails', () => {
  const failure = { kind: 'network', retryAfterSeconds: null };
  let state = resultsReducer(initialResults, { type: 'search', requestId: 1, filterKey: 'a' });
  state = resultsReducer(state, { type: 'loaded', requestId: 1, venues: [venue(1)], nextCursor: id(1), append: false });
  const more = resultsReducer(resultsReducer(state, { type: 'more', requestId: 2 }), { type: 'failed', requestId: 2, failure, append: true });
  assert.equal(more.status, 'ready'); assert.equal(more.venues.length, 1); assert.equal(more.nextCursor, id(1)); assert.equal(more.failure, failure);
  const search = resultsReducer(resultsReducer(state, { type: 'search', requestId: 3, filterKey: 'a' }), { type: 'failed', requestId: 3, failure, append: false });
  assert.equal(search.status, 'error'); assert.equal(search.venues.length, 0, 'No stale venues beside an error');
  assert.match(resultsSummary(search), /Couldn’t reach/);
  assert.equal(resultsReducer(state, { type: 'remove', id: id(1) }).venues.length, 0);
  const empty = resultsReducer(resultsReducer(initialResults, { type: 'search', requestId: 1, filterKey: 'a' }), { type: 'loaded', requestId: 1, venues: [], nextCursor: null, append: false });
  assert.match(resultsSummary(empty), /No approved venues/);
});

test('every listing state offers contact/directions copy and never booking', () => {
  for (const claim of ['unclaimed', 'pending', 'verified']) {
    const notice = listingNotice(claim);
    assert.match(notice.text, /Contact the venue directly/);
    assert.match(notice.text, /can’t be booked|isn’t available/);
    assert.match(markerDescription(claim), /Not bookable/);
  }
  assert.equal(listingNotice('unclaimed').badge, 'Unclaimed listing');
  const links = directionsLinks(14.5995, 120.9842);
  assert.equal(new URL(links.apple).searchParams.get('daddr'), '14.599500,120.984200');
  assert.equal(new URL(links.google).searchParams.get('destination'), '14.599500,120.984200');
  assert.equal(new URL(links.google).hostname, 'www.google.com');
  assert.equal(courtSummary({ surface: 'hard', is_indoor: false, is_covered: true }), 'Outdoor · Covered · Hard surface');
  assert.equal(courtSummary({ surface: null, is_indoor: true, is_covered: true }), 'Indoor');
});
