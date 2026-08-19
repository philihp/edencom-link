-- ── fitting_write_log ─────────────────────────────────────────────────────
-- Every change this deployment has made to a character's in-game fitting
-- library, and the only place a deleted fit survives if nothing else does.
--
-- This is the app's first write path to ESI: everywhere else, tokens are
-- read-only and CCP's copy of the universe is something we mirror, never
-- touch. The fittings archive (docs/fitting-fuse.md) breaks that, because the
-- feature *is* deleting: a character may keep 500 fits saved, and archiving
-- one means storing it here and then removing it from the game so the slot
-- comes free.
--
-- So the log is written BEFORE the ESI call, not after it, and it carries the
-- fit's whole body — name, ship, every module — not a reference to a row
-- elsewhere. A crash between the insert and CCP's 204 leaves a 'pending' row
-- holding a complete, restorable copy of a fit that may or may not still
-- exist; the far worse shape, a fit deleted from the game with nothing on this
-- side to replay, cannot happen. character_fitting_over_time keeps history
-- too, but it is a mirror of what the extract last saw, and a fit created and
-- deleted between two extracts would never appear in it at all.
--
-- Append-only in practice: rows are inserted 'pending' and updated once to
-- 'ok' or 'error'. Nothing deletes from here.
create table if not exists public.fitting_write_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  registration_id uuid not null references public.registration(id) on delete cascade,
  -- 'delete' removed a fit from the game; 'create' put one back (or saved a
  -- brand new one). Named for what happened in EVE, not for what the player
  -- called it in the filesystem.
  op text not null check (op in ('create', 'delete')),
  -- The game's id: the fit being deleted, or the id ESI minted for a created
  -- one (null until it answers, and on a failed create).
  fitting_id bigint,
  -- The fit itself, complete enough to POST back verbatim.
  name text,
  description text,
  ship_type_id bigint,
  items jsonb not null default '[]'::jsonb,
  -- src/fittingArchive.ts contentHash over the four fields above: what makes
  -- "this fit is already saved in game" answerable without comparing blobs.
  content_hash text not null,
  -- What asked for this. 'fuse' is the macOS filesystem client; the column
  -- exists so a future UI path is distinguishable in the audit trail.
  source text not null default 'api',
  status text not null check (status in ('pending', 'ok', 'error')),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists fitting_write_log_registration_id_idx
  on public.fitting_write_log (registration_id, created_at desc);
create index if not exists fitting_write_log_content_hash_idx
  on public.fitting_write_log (registration_id, content_hash);

alter table public.fitting_write_log enable row level security;
-- Readable by its owner so the audit trail is theirs to inspect; written only
-- by the service role, because the route that writes it is also the only thing
-- allowed to call ESI. A browser session can never insert a row claiming a
-- delete happened.
drop policy if exists "Users read own fitting writes" on public.fitting_write_log;
create policy "Users read own fitting writes"
  on public.fitting_write_log
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.fitting_write_log to authenticated;
grant all    on public.fitting_write_log to service_role;

