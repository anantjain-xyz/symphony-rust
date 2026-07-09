create table if not exists retro_suggestions (
  id text primary key,
  retro_id text not null references retros(id) on delete cascade,
  repo_name text not null,
  repo_url text,
  finding_index integer not null,
  target_type text not null check (target_type in ('prompt', 'skill')),
  target_id text not null,
  target_path text not null,
  title text not null,
  body text not null,
  rationale text not null,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  guidance text not null,
  before_content text,
  after_content text,
  unified_diff text,
  base_ref text,
  base_hash text,
  proposal_status text not null check (proposal_status in ('ready', 'unavailable')),
  proposal_error text,
  decision text not null default 'pending' check (decision in ('pending', 'accepted', 'rejected')),
  decided_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (retro_id, repo_name, target_type, target_id, finding_index)
);

create index if not exists retro_suggestions_retro_idx
  on retro_suggestions (retro_id, finding_index);
create index if not exists retro_suggestions_decision_idx
  on retro_suggestions (retro_id, decision);

create table if not exists retro_batches (
  id text primary key,
  retro_id text not null references retros(id) on delete cascade,
  kind text not null check (kind in ('repo_pr', 'workflow_update')),
  repo_name text,
  repo_url text,
  base_ref text,
  state text not null check (state in ('queued', 'running', 'completed', 'failed', 'stale')),
  progress text,
  error text,
  pr_url text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at text
);

create index if not exists retro_batches_retro_idx
  on retro_batches (retro_id, created_at);

create table if not exists retro_batch_items (
  batch_id text not null references retro_batches(id) on delete cascade,
  suggestion_id text not null references retro_suggestions(id) on delete cascade,
  primary key (batch_id, suggestion_id)
);
