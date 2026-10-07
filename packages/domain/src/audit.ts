export type DirectoryAuditAction =
  | 'directory.create'
  | 'directory.update'
  | 'directory.publish'
  | 'directory.unpublish'
  | 'directory.suspend'
  | 'directory.import'
  | 'owner.update'
  | 'owner.photo_add'
  | 'owner.photo_remove'
  | 'schedule.update'
  | 'policy.update'
  | 'allocation.block'
  | 'allocation.release'
  | 'schedule.court_update';

/** Safe audit projection; no request bodies, evidence, names or credentials. */
export type DirectoryAuditEvent = {
  /** Decimal bigint string: never round through a JavaScript number. */
  id: string;
  actor_user_id: string;
  target_venue_id: string;
  action: DirectoryAuditAction;
  occurred_at: string;
};

export type DirectoryAuditPage = {
  items: DirectoryAuditEvent[];
  next_cursor: string | null;
};
