export type PrivilegedRole = 'admin' | 'moderator';

/** Own-account display data; email and permissions are deliberately absent. */
export type Profile = {
  id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
};

/** Current database assignments. Read for UI; server commands enforce access. */
export type AccountAccess = {
  privileged_roles: PrivilegedRole[];
  owned_venue_ids: string[];
};
