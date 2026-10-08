// Loads the shipped owner front-desk client for unit tests and the local real-API harness.
const path = require('node:path');
const rental = require('../../rental/__tests__/helpers.cjs');
const { load, root, client: rentalClient } = rental;
const domain = { ...rental.domain, ...['session', 'sessionBooking'].reduce((all, name) => ({ ...all, ...require(path.join(root, `packages/domain/src/${name}.ts`)) }), {}) };
const here = path.dirname(module.filename); const venueClient = require('../venueClient.ts');
const ops = load(path.join(here, '../operationsModel.ts'), { '@picklyph/domain': domain }, { Intl });
const walkIns = load(path.join(here, '../walkInClient.ts'), { '@picklyph/domain': domain, './venueClient': venueClient, './operationsModel': ops }, { Intl });
const desk = load(path.join(here, '../deskClient.ts'), { '@picklyph/domain': domain, './venueClient': venueClient, './walkInClient': walkIns,
  '../rental/client': rentalClient }, { Intl });
module.exports = { rental, domain, ops, walkIns, desk };
