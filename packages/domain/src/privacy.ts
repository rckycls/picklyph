/** T47 account deletion: the body the account-deletion function accepts and its replies. See docs/privacy.md. */
export const ACCOUNT_DELETION_CONFIRMATION = 'delete_account';
/** Room for the confirmation and one Apple authorization code (T50a). */
export const MAX_ACCOUNT_DELETION_BYTES = 2048;
/** Apple documents no format for authorization codes, so any visible ASCII without spaces, bounded. */
const APPLE_CODE = /^[\x21-\x7e]{8,1024}$/;

/**
 * An explicit body, so no empty or replayed request from another endpoint can delete an account. Never carries an actor.
 * `apple_authorization_code` (T50a): a fresh, single-use Sign in with Apple code, required only when the account has an
 * Apple identity, so the server can revoke the app's Apple tokens before the account is gone.
 */
export type AccountDeletionRequest = { confirm: typeof ACCOUNT_DELETION_CONFIRMATION; apple_authorization_code?: string };
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
/**
 * T50a refusals for Apple-linked accounts: `apple_reauthorization_required` (409: no code, or Apple refused it as invalid,
 * expired or used; confirm with Apple again) and `apple_account_mismatch` (403: the code belongs to another Apple ID).
 */
export const APPLE_DELETION_REJECTIONS = ['apple_reauthorization_required', 'apple_account_mismatch'] as const;

export class PrivacyInputError extends Error {
  constructor(message = 'Invalid account deletion request.') { super(message); this.name = 'PrivacyInputError'; }
}

/** Strict body: `{ "confirm": "delete_account" }`, optionally with `apple_authorization_code`. */
export function readAccountDeletionRequest(raw: unknown): AccountDeletionRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new PrivacyInputError();
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(',');
  if ((keys !== 'confirm' && keys !== 'apple_authorization_code,confirm') || input.confirm !== ACCOUNT_DELETION_CONFIRMATION) throw new PrivacyInputError();
  if (keys === 'confirm') return { confirm: ACCOUNT_DELETION_CONFIRMATION };
  const code = input.apple_authorization_code;
  if (typeof code !== 'string' || !APPLE_CODE.test(code)) throw new PrivacyInputError();
  return { confirm: ACCOUNT_DELETION_CONFIRMATION, apple_authorization_code: code };
}
