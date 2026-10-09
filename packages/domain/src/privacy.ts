/** T47 account deletion: the body the account-deletion function accepts and its replies. See docs/privacy.md. */
export const ACCOUNT_DELETION_CONFIRMATION = 'delete_account';
export const MAX_ACCOUNT_DELETION_BYTES = 256;

/** An explicit body, so no empty or replayed request from another endpoint can delete an account. Never carries an actor. */
export type AccountDeletionRequest = { confirm: typeof ACCOUNT_DELETION_CONFIRMATION };
/** The only success reply, also returned to a retry whose token outlived the deleted account. */
export type AccountDeletionResult = { status: 'deleted' };
/** `account_deletion_begin`: what this call changed (a retry after a partial run reports `existing` and zeros). */
export type AccountDeletionBegin = {
  outcome: 'started' | 'existing';
  released_venues: number;
  retired_drafts: number;
  cancelled_rentals: number;
  cancelled_groups: number;
  erased_groups: number;
};
/** `account_deletion_status`: `deleted` only when deletion started and the Auth user is gone. */
export type AccountDeletionStatus = 'none' | 'pending' | 'deleted';

export class PrivacyInputError extends Error {
  constructor(message = 'Invalid account deletion request.') { super(message); this.name = 'PrivacyInputError'; }
}

/** Strict body: exactly `{ "confirm": "delete_account" }`. */
export function readAccountDeletionRequest(raw: unknown): AccountDeletionRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new PrivacyInputError();
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).join(',') !== 'confirm' || input.confirm !== ACCOUNT_DELETION_CONFIRMATION) throw new PrivacyInputError();
  return { confirm: ACCOUNT_DELETION_CONFIRMATION };
}
