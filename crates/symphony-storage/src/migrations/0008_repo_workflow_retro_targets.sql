alter table retro_batch_items rename to retro_batch_items_old;
alter table retro_suggestions rename to retro_suggestions_old;

create table retro_suggestions (
  id text primary key,
  retro_id text not null references retros(id) on delete cascade,
  repo_name text not null,
  repo_url text,
  finding_index integer not null,
  target_type text not null check (target_type in ('prompt', 'repo_workflow', 'skill')),
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

insert into retro_suggestions select * from retro_suggestions_old;

create table retro_batch_items (
  batch_id text not null references retro_batches(id) on delete cascade,
  suggestion_id text not null references retro_suggestions(id) on delete cascade,
  primary key (batch_id, suggestion_id)
);

insert into retro_batch_items select * from retro_batch_items_old;

drop table retro_batch_items_old;
drop table retro_suggestions_old;

create index retro_suggestions_retro_idx
  on retro_suggestions (retro_id, finding_index);
create index retro_suggestions_decision_idx
  on retro_suggestions (retro_id, decision);
