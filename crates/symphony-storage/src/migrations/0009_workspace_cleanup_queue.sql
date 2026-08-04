create table workspace_cleanup_queue (
  id text primary key,
  repo_name text not null,
  issue_identifier text not null,
  source_path text not null,
  quarantine_path text not null unique,
  status text not null check (status in ('quarantining', 'queued', 'running', 'retry_wait')),
  attempts integer not null default 0,
  next_attempt_at text not null,
  last_error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index workspace_cleanup_queue_due_idx
  on workspace_cleanup_queue (status, next_attempt_at);
