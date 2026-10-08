const path = require('node:path');
const load = require('../../../../supabase/tests/load-ts.cjs');
const here = path.dirname(module.filename);
const root = path.resolve(here, '../../../..');
const domain = Object.assign({}, ...['booking', 'money', 'rental', 'rentalBooking', 'operations'].map(name => require(path.join(root, `packages/domain/src/${name}.ts`))));
const imports = { '@picklyph/domain': domain, '../owner/venueClient': require('../../owner/venueClient.ts') };
imports['../owner/operationsModel'] = load(path.join(root, 'src/features/owner/operationsModel.ts'), imports, { Intl });
const client = load(path.join(here, '../client.ts'), imports, { Intl });
const model = load(path.join(here, '../model.ts'), imports, { Intl });
const { createAttemptJournal } = load(path.join(here, '../attempt.ts'), { ...imports, './model': model }, { Intl });
const VENUE = 'a2500000-0000-4000-8000-000000000001';
const COURT = 'b2500000-0000-4000-8000-000000000001';
const ID = 'c2500000-0000-4000-8000-000000000001';
const REQUEST = 'd2500000-0000-4000-8000-000000000001';
const starts_at = '2026-10-10T10:00:00.000Z'; const ends_at = '2026-10-10T11:30:00.000Z';
const quote = () => ({ ...domain.priceRental(starts_at, ends_at, [{ starts_at, ends_at: '2026-10-10T11:00:00.000Z', hourly_centavos: 40000 },
  { starts_at: '2026-10-10T11:00:00.000Z', ends_at, hourly_centavos: 60000 }]),
  venue_id: VENUE, court_id: COURT, starts_at, ends_at, quoted_at: '2026-10-08T01:00:00.123456+00:00',
  policy: { confirmation: 'instant', payment: 'arrival', merchant_active: false },
  expected_quote: { total_centavos: 70000, schedule_revision: '3', court_hours_revision: null, policy_revision: '0' } });
const booking = (status = 'confirmed') => {
  const q = quote(); const pending = status === 'pending'; const expired = status === 'expired';
  return { id: ID, source: 'player', guest_name: null, status, payment_method: 'arrival', payment_status: 'unpaid', operations: { attendance: 'none', attendance_at: null, payment: null },  created_at: q.quoted_at, updated_at: q.quoted_at,
    allocation: { id: ID, venue_id: VENUE, court_id: COURT, kind: 'rental', starts_at, ends_at,
      state: pending || status === 'confirmed' ? 'active' : expired ? 'expired' : 'released',
      expires_at: pending || expired ? '2026-10-08T03:00:00.000Z' : null, ended_at: pending || status === 'confirmed' ? null : '2026-10-08T03:00:00.000Z' },
    snapshot: { currency: q.currency, pricing: q.pricing, duration_minutes: q.duration_minutes, total_centavos: q.total_centavos, bands: q.bands,
      version: 1, allocation_id: ID, venue_id: VENUE, court_id: COURT, starts_at, ends_at, created_at: q.quoted_at, ...q.expected_quote,
      policy: { ...q.policy, confirmation: pending || expired ? 'approval' : 'instant', player_refund_cutoff_hours: 24, approval_hold_minutes: 120, payment_hold_minutes: 15 } } };
};
const plain = value => JSON.parse(JSON.stringify(value));
const response = (body, status = 200, headers = {}) => {
  const r = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  // Expo's native FetchResponse does not inherit global Response.
  return { ok: r.ok, status: r.status, headers: r.headers, json: () => r.json() };
};
const transport = fetch => ({ endpoint: 'https://rental.test/functions/v1/rental-bookings', apiKey: 'public-fixture', accessToken: async () => 'fixture-token', fetch });
const memory = () => {
  const values = new Map(); const operations = [];
  return { values, operations, get: async key => values.get(key) ?? null,
    set: async (key, value) => { operations.push('persist'); values.set(key, value); },
    remove: async key => { operations.push('remove'); values.delete(key); } };
};
module.exports = { load, root, domain, imports, client, model, createAttemptJournal, VENUE, COURT, ID, REQUEST, quote, booking, plain, response, transport, memory };
