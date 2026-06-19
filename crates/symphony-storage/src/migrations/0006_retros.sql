create table if not exists retros (
  id text primary key,
  since_at text not null,
  until_at text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  run_count integer not null default 0,
  issue_count integer not null default 0,
  report_json text,
  error_message text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at text
);

create index if not exists retros_status_idx on retros (status);
create index if not exists retros_completed_idx on retros (completed_at desc);

create table if not exists retro_inputs (
  retro_id text not null references retros(id) on delete cascade,
  run_id text not null references runs(id) on delete cascade,
  issue_id text not null references issues(id) on delete cascade,
  repo_name text,
  workpad_comment_id text,
  workpad_hash text,
  primary key (retro_id, run_id)
);

create index if not exists retro_inputs_issue_idx on retro_inputs (issue_id);
create index if not exists retro_inputs_repo_idx on retro_inputs (repo_name);

create table if not exists workpad_snapshots (
  issue_id text primary key references issues(id) on delete cascade,
  comment_id text not null,
  body_hash text not null,
  body text not null,
  comment_created_at text,
  comment_updated_at text,
  fetched_at text not null
);
