export type DirectoryAuditAction =
  | 'directory.create'
  | 'directory.update'
  | 'directory.publish'
  | 'directory.unpublish'
  | 'directory.suspend'
  | 'directory.import'
  | 'owner.create'
  | 'owner.update'
  | 'owner.photo_add'
  | 'owner.photo_remove'
  | 'schedule.update'
  | 'policy.update'
  | 'allocation.block'
  | 'allocation.release'
  | 'schedule.court_update'
  | 'session.create'
  | 'session.cancel'
  | 'directory.delete'
  | 'prelaunch.register'
  | 'prelaunch.retire';

/** Safe audit projection; no request bodies, evidence, names or credentials. */
export type DirectoryAuditEvent = {
  /** Decimal bigint string: never round through a JavaScript number. */
  id: string;
  /** For `prelaunch.*` actions, the pre-launch registration (T53): no account exists yet. */
  actor_user_id: string;
  target_venue_id: string;
  action: DirectoryAuditAction;
  occurred_at: string;
};

export type DirectoryAuditPage = {
  items: DirectoryAuditEvent[];
  next_cursor: string | null;
};
