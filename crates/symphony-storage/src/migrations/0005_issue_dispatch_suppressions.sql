create table if not exists issue_dispatch_suppressions (
  issue_id text not null references issues(id) on delete cascade,
  reason text not null,
  issue_fingerprint text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (issue_id, reason)
);
