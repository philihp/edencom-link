-- docs/fitting-marshal.md PR 1: the archive table for fits marshalled out of
-- the game. Additive; nothing reads it until the /api/fittings/marshalled
-- routes in the same PR. Mirrors the schema.sql section verbatim.

-- ── marshalled_fitting ────────────────────────────────────────────────────
-- A fit that is ours but not in the game: marshalled out of a character's
-- 500 saved-fitting slots into this table, to be unmarshalled back onto any
-- character of the account later (docs/fitting-marshal.md). The fitting
-- archive the FUSE mount shipped keeps the player's own disk as the archive;
-- this is the same archive held here, so it survives a lost laptop and
-- follows the account rather than a character.
--
-- Account-level, keyed on user_id like `link` and `bpo_share`: a marshalled
-- fit has no fitting_id (EVE deleted it, and reassigns one on every save) and
-- no character (the player picks one when it goes back). The source character
-- is kept as provenance only, `on delete set null` so unlinking the character
-- keeps the fit.
--
-- THE HANDLE IS THE CONTENT HASH — src/fittingArchive.ts contentHash, sha256
-- over the normalized (ship, name, description, items), 64 hex. It is the
-- primary key with user_id, the last path segment of /api/fittings/marshalled
-- and the filename key in the mount's Marshalled/ folder. One row per distinct
-- fit per account: marshalling the same fit from two alts frees two slots and
-- keeps one row (the upsert refreshes marshalled_at and the provenance).
-- `items` is stored already normalized, so the row IS the POST body and hashes
-- to its own key.
--
-- Owner-readable; written only by the service role after the request has
-- proved who it is (the api_token for the routes, the cookie session for the
-- server actions). A browser session can never insert a row claiming a fit
-- left the game — the same rule as fitting_write_log, which `write_log_id`
-- points at for a fit that arrived through an ESI delete (null for a file the
-- owner copied in). There is no share row and no audience policy: the set of
-- fits an account has marshalled is the owner's alone.
create table public.marshalled_fitting (
  user_id uuid not null references auth.users(id) on delete cascade,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  name text not null,
  description text not null default '',
  ship_type_id bigint not null,
  items jsonb not null default '[]'::jsonb,
  source_registration_id uuid references public.registration(id) on delete set null,
  source_fitting_id bigint,
  write_log_id bigint references public.fitting_write_log(id) on delete set null,
  -- What stored it: 'web' (a button), 'fuse' (the mount), 'api' (anything else
  -- carrying the api_token) — the fitting_write_log vocabulary.
  source text not null default 'api',
  marshalled_at timestamptz not null default now(),
  primary key (user_id, content_hash)
);
create index marshalled_fitting_user_recent_idx
  on public.marshalled_fitting (user_id, marshalled_at desc);

alter table public.marshalled_fitting enable row level security;
create policy "Users read own marshalled fittings"
  on public.marshalled_fitting
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.marshalled_fitting to authenticated;
grant all    on public.marshalled_fitting to service_role;

