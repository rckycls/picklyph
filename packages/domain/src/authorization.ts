export type PrivilegedRole = 'admin' | 'moderator';

/** Own-account display data; email and permissions are deliberately absent. */
export type Profile = {
  id: string;
  display_name: string | null;
  /** Personal details, self-only like the rest of the row. */
  first_name: string | null;
  last_name: string | null;
  /** Philippine mobile number in E.164 (+639XXXXXXXXX). */
  phone: string | null;
  /** Object in the private `avatars` bucket under the account's own folder. */
  avatar_path: string | null;
  created_at: string;
  updated_at: string;
};

/** Current database assignments. Read for UI; server commands enforce access. */
export type AccountAccess = {
  privileged_roles: PrivilegedRole[];
  /** Approved listings this account is a verified owner of. */
  owned_venue_ids: string[];
  /** Draft venues this account created and is setting up while pickly reviews them. */
  pending_venue_ids: string[];
};
