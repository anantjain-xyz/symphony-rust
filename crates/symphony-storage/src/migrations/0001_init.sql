pragma foreign_keys = on;

create table if not exists workflows (
  id text primary key,
  source_hash text not null unique,
  parsed text not null,
  prompt_template text not null,
  loaded_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists workflows_loaded_at_idx on workflows (loaded_at desc);

create table if not exists issues (
  id text primary key,
  identifier text not null unique,
  title text not null,
  description text,
  priority integer not null default 0,
  state text not null,
  branch text,
  labels text not null default '[]',
  blockers text not null default '[]',
  pr_urls text not null default '[]',
  raw text not null,
  last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists issues_state_idx on issues (state);
create index if not exists issues_priority_idx on issues (priority desc);

create table if not exists runs (
  id text primary key,
  issue_id text not null references issues(id) on delete cascade,
  run_number integer not null,
  workspace_path text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'success', 'failure', 'timeout', 'cancelled')),
  started_at text,
  ended_at text,
  error_class text,
  error_message text,
  worker_pid integer,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (issue_id, run_number)
);

create index if not exists runs_status_idx on runs (status);
create index if not exists runs_issue_idx on runs (issue_id, run_number desc);
create index if not exists runs_running_idx on runs (started_at desc) where status = 'running';
create unique index if not exists runs_one_running_per_issue on runs (issue_id) where status = 'running';

create table if not exists live_sessions (
  run_id text primary key references runs(id) on delete cascade,
  session_id text not null,
  thread_id text not null,
  turn_id text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  last_event_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists agent_events (
  id integer primary key autoincrement,
  run_id text not null references runs(id) on delete cascade,
  kind text not null check (kind in ('status', 'tool_call', 'approval', 'token_count', 'error', 'user_input', 'humanized', 'rate_limit')),
  payload text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists agent_events_run_idx on agent_events (run_id, id);
create index if not exists agent_events_created_idx on agent_events (created_at desc);

create view if not exists agent_events_latest as
select e.*
from agent_events e
join (
  select run_id, max(id) as max_id
  from agent_events
  group by run_id
) latest on latest.run_id = e.run_id and latest.max_id = e.id;

create table if not exists retry_queue (
  issue_id text primary key references issues(id) on delete cascade,
  run_number integer not null,
  due_at text not null,
  error_class text,
  error_message text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists retry_queue_due_idx on retry_queue (due_at);

create table if not exists hook_runs (
  id integer primary key autoincrement,
  run_id text references runs(id) on delete cascade,
  hook text not null check (hook in ('after_create', 'before_run', 'after_run', 'before_remove')),
  exit_code integer not null,
  duration_ms integer not null,
  stderr_tail text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists hook_runs_run_idx on hook_runs (run_id, created_at desc);

create table if not exists rate_limit_state (
  source text primary key,
  remaining integer,
  reset_at text,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists worker_heartbeat (
  id text primary key default 'worker' check (id = 'worker'),
  started_at text not null,
  last_beat_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  worker_pid integer
);
