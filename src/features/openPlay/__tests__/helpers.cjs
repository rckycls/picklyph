// Loads the actual mobile open-play modules for unit tests and the real local API check (supabase/tests/session-bookings-local.cjs).
const path = require('node:path');
const load = require('../../../../supabase/tests/load-ts.cjs');
const here = path.dirname(module.filename);
const root = path.resolve(here, '../../../..');
const domain = Object.assign({}, ...['booking', 'money', 'session', 'sessionBooking'].map(name => require(path.join(root, `packages/domain/src/${name}.ts`))));
const venueClient = require('../../owner/venueClient.ts');
const imports = { '@picklyph/domain': domain, '../owner/venueClient': venueClient, './venueClient': venueClient };
imports['../owner/walkInClient'] = load(path.join(root, 'src/features/owner/walkInClient.ts'), imports);
const client = load(path.join(here, '../client.ts'), imports, { Intl });
const model = load(path.join(here, '../model.ts'), imports, { Intl });
const { createGroupJournal } = load(path.join(here, '../attempt.ts'), { ...imports, './model': model }, { Intl });
const rentalModel = load(path.join(root, 'src/features/rental/model.ts'), imports, { Intl });
const plain = value => JSON.parse(JSON.stringify(value));
const memory = () => {
  const values = new Map(); const operations = [];
  return { values, operations, get: async key => values.get(key) ?? null,
    set: async (key, value) => { operations.push('persist'); values.set(key, value); },
    remove: async key => { operations.push('remove'); values.delete(key); } };
};
module.exports = { load, root, domain, client, model, createGroupJournal, rentalModel, plain, memory };
