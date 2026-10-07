export type VenuePolicy = { confirmation: 'instant' | 'approval'; payment: 'arrival' | 'online' | 'both' };
export type VenuePolicyView = VenuePolicy & { venue_id: string; revision: string; merchant_active: boolean };
export type VenuePolicySave = { kind: 'save_policy'; venue_id: string; expected_revision: string; policy: VenuePolicy };

/** Strict contract: actor and merchant state are never accepted from callers. */
export function readPolicySave(raw: unknown): VenuePolicySave {
  const fail = (): never => { throw new Error('Invalid venue policy'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'expected_revision,kind,policy,venue_id'
    || r.kind !== 'save_policy' || typeof r.venue_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.venue_id)
    || typeof r.expected_revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(r.expected_revision)
    || !r.policy || typeof r.policy !== 'object' || Array.isArray(r.policy)) return fail();
  const p = r.policy as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'confirmation,payment'
    || (p.confirmation !== 'instant' && p.confirmation !== 'approval')
    || (p.payment !== 'arrival' && p.payment !== 'online' && p.payment !== 'both')) return fail();
  return { kind: 'save_policy', venue_id: r.venue_id.toLowerCase(), expected_revision: r.expected_revision,
    policy: { confirmation: p.confirmation, payment: p.payment } };
}
