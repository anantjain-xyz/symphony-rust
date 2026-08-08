# Storage and migrations

This document defines how Symphony opens, upgrades, verifies, and recovers its
SQLite database. It applies to
[`symphony-storage`](../crates/symphony-storage/src/lib.rs), its repository
methods, and SQL files under
[`crates/symphony-storage/src/migrations`](../crates/symphony-storage/src/migrations).

## Status

**Current behavior** describes the implementation today. **Proposed
invariants** are rules for future schema work. Migration contract tests enforce
exact file inventory, registry order, and shipped SQL checksums, and they
exercise every historical upgrade prefix through head. Fresh-versus-upgraded
`sqlite_schema` fingerprint comparison is still a remaining gap.

## Database opening

### Current behavior

`open_sqlite` creates the database's parent directory and opens SQLite with:

- create-if-missing enabled;
- write-ahead logging;
- a 10-second busy timeout;
- `NORMAL` synchronous mode;
- a pool limit of eight connections.

It then runs all pending migrations before returning the pool. Startup therefore
fails instead of exposing a partially upgraded repository when migration
application returns an error.

The desktop app stores the database as `symphony.sqlite` inside its app-data
directory. Settings and the Linear API key have separate persistence paths:
settings JSON in app data and the API key in the operating-system keychain.

### Proposed invariant

All production repository access must use `open_sqlite` or an equivalent entry
point that completes migration first. Code must not open a second connection
with incompatible journal, timeout, or foreign-key behavior.

Any change to connection pragmas needs concurrent-reader/writer tests and a
clear crash-durability rationale.

## Migration registry and application

### Current behavior

[`MIGRATIONS`](../crates/symphony-storage/src/lib.rs) is a manually maintained
ordered slice. It pairs IDs with `include_str!` SQL files. The current sequence
runs from `0001_init` through `0009_workspace_cleanup_queue`.

Migration state is stored in:

```sql
create table if not exists schema_migrations (
  id text primary key,
  applied_at text not null
    default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

For each registry entry, the migrator:

1. skips the entry if its ID is already present;
2. starts a transaction;
3. splits the SQL text on semicolons and executes each non-empty statement;
4. inserts the migration ID in the same transaction;
5. commits.

An error rolls back both schema statements and the marker. Migration `0001`
predates `schema_migrations` and remains idempotent so a database created before
version tracking can replay it and then catch up.

Storage tests cover pre-versioning upgrade, repeated migration, and atomic
rollback of a failed migration. Migration contract tests
([`migration_contract_tests.rs`](../crates/symphony-storage/src/migration_contract_tests.rs))
additionally assert that:

- the migrations directory matches the `MIGRATIONS` registry exactly;
- migration IDs are unique, strictly ordered, and contiguous;
- every shipped migration SQL blob matches a frozen SHA-256 checksum;
- every historical prefix (`0..=N`) upgrades safely to head, remains
  idempotent, preserves seeded sentinel data, and passes
  `PRAGMA integrity_check` / foreign-key checks.

### Current limitations

- Files are not discovered automatically; a new SQL file does nothing until it
  is added to `MIGRATIONS`.
- Applied `schema_migrations` rows still store IDs and timestamps only; SQL
  checksums live in the contract-test registry, not in the database.
- Editing a shipped migration fails the checksum contract tests, but there is
  no separate production-time immutability gate beyond those tests and review.
- Nothing compares a fresh database `sqlite_schema` fingerprint with a database
  upgraded through every historical migration.
- The simple semicolon splitter is not a full SQLite parser.

### Proposed invariant

Once a migration reaches `main` and can be installed by users, it is immutable:
do not edit, rename, delete, reorder, or reuse it. Correct mistakes with a new
forward migration.

Every schema pull request must:

1. choose the next unused four-digit prefix;
2. use a descriptive ID that exactly matches the file stem;
3. add the SQL file and registry entry in the same commit;
4. keep the registry strictly sorted with unique IDs and files;
5. preserve data and indexes during table rebuilds;
6. add an upgrade test from the previous schema state;
7. prove a second startup is a no-op.

Branches can choose the same next number concurrently. After merging
`origin/main`, resolve that collision by renumbering the unreleased migration
and its registry ID before publication. Never renumber a migration already
released on `main`.

Because application currently uses `sql.split(';')`, migration SQL must not
depend on semicolons inside trigger bodies, string literals, or other compound
constructs. If such SQL is required, improve the migrator first and add parser
coverage.

## Schema change patterns

### Adding a table or index

Use explicit names and constraints. Decide whether deletes should restrict,
cascade, or set null, and test that behavior. Add indexes for the queries that
will use them rather than copying indexes speculatively.

### Adding a column

Choose a default or nullability that works for every existing row. Backfill
inside the migration when later code assumes a non-null semantic value.

### Changing constraints or column types

SQLite often requires a table rebuild:

1. create the replacement table with the final schema;
2. copy and transform rows explicitly;
3. verify row counts and required values;
4. drop the old table;
5. rename the replacement;
6. recreate indexes, triggers, and foreign keys.

Keep all steps in the migration transaction. Test representative legacy rows,
not only an empty database.

### Removing data

Prefer a staged rollout when older application versions might still read the
database: stop writing first, then remove the schema in a later release. A
destructive migration needs explicit release notes and a tested backup/recovery
path.

## Upgrade and integrity verification

### Current behavior

The storage test suite creates temporary databases and runs the migrator.
Migration contract tests enforce exact inventory, order, and checksums, and
they upgrade every historical prefix to head with sentinel data and integrity
checks. There is no checked-in production database fixture and no automated
fresh-versus-upgraded `sqlite_schema` fingerprint comparison.

### Proposed invariant

For each migration, verify both paths:

- **Fresh install:** migrate an empty database through the complete registry.
- **Upgrade:** create the immediately previous schema with representative data,
  then run the new registry.

Both paths should end with equivalent `sqlite_schema` definitions, required
data, and indexes. Normalize only irrelevant SQLite formatting or object-order
differences; do not mask real schema drift. Contract tests already cover
prefix-to-head upgrades and integrity; closing the remaining gap means adding
an explicit fresh-versus-upgraded schema fingerprint comparison.

After migration, run:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
SELECT id, applied_at FROM schema_migrations ORDER BY id;
```

`integrity_check` must return `ok`. `foreign_key_check` must return no rows. The
migration table must contain exactly the expected released IDs.

The minimum local validation is:

```sh
cargo test -p symphony-storage
cargo test --workspace --exclude symphony-desktop
```

Registry ordering, unique IDs, exact file-to-registry correspondence, and
shipped SQL checksums are enforced by the migration contract tests. A future
integration test should still compare fresh and upgraded schema fingerprints;
that fingerprint check does not exist today.

## Repository writes and invalidation

### Current behavior

Repository mutation methods publish [`StorageEvent`](../crates/symphony-storage/src/lib.rs)
notifications after successful writes. Most changes emit `DbChanged` with a
table and operation. Agent events and rate-limit updates also emit their narrow
typed event.

The frontend's table-to-resource mapping is manual; see
[`IPC-CONTRACT.md`](IPC-CONTRACT.md) and
[`FRONTEND-ASYNC-INVARIANTS.md`](FRONTEND-ASYNC-INVARIANTS.md).

### Proposed invariant

A durable mutation and its invalidation form one behavioral change. Adding,
renaming, or moving a persisted table requires reviewing:

- every repository write and transaction boundary;
- emitted table and operation strings;
- typed events, if any;
- frontend invalidation mappings;
- hidden-view dirty behavior;
- selected-detail refresh tests.

Emit only after the transaction succeeds. A rolled-back write must not advertise
data that never committed. If event delivery is best-effort, periodic or
visibility-triggered refresh must remain a recovery path.

## Operational recovery

Before manual repair, stop Symphony and copy the database, its `-wal`, and its
`-shm` files together while they are quiescent. Keep the original untouched
until recovery is verified.

If startup migration fails:

1. save the exact error and application logs;
2. preserve a copy of all SQLite files;
3. reproduce against the copy;
4. inspect `schema_migrations`, `sqlite_schema`, `integrity_check`, and
   `foreign_key_check`;
5. fix forward with a new migration whenever possible;
6. validate both the copied upgrade and a fresh install before shipping.

Do not insert or delete a `schema_migrations` row merely to bypass an error. The
marker is evidence that the corresponding transaction committed. Changing it
without reconciling the actual schema can make every later upgrade unsafe.

If a released migration was edited accidentally, restore its original bytes and
ship a new corrective migration. Existing databases have already skipped the
old ID, while fresh databases would execute the edited SQL; retaining the edit
would permanently split those populations.

## Migration review checklist

- [ ] The ID and filename are new, unique, sorted, and registered.
- [ ] No released migration changed.
- [ ] SQL is compatible with the current semicolon executor.
- [ ] Existing rows have valid defaults or explicit backfills.
- [ ] Foreign keys, indexes, and cascade behavior are preserved.
- [ ] Fresh install, previous-version upgrade, and second-run behavior pass.
- [ ] Failure rolls back statements and the migration marker together.
- [ ] Integrity and foreign-key checks pass.
- [ ] Repository events and frontend resource mappings cover the change.
- [ ] Destructive changes include a user-data recovery plan.
