-- Public share links for one saved fitting, mirroring shared_asset_token
-- (the /ship/[itemId]?token=… pattern): token text primary key, minted by the
-- owner, resolved anonymously via the service-role client. Anyone who has the
-- URL can view the fit without signing in; the fit itself is never copied —
-- character_fitting_share points at the live (character_id, fitting_id) pair,
-- not a snapshot, so an edit in the client is visible through the link too
-- and there's nothing to keep in sync.
--
-- (character_id, fitting_id) rather than character_fitting_over_time's own
-- surrogate `id`: that id is an SCD *version* stamp and changes every time the
-- fit is edited in the client, so a share pinned to it would silently break
-- on the next edit. (character_id, fitting_id) is the fit's durable identity
-- — the same pair the /fitting/[characterId]/[fittingId] route addresses it
-- by — so the share and the URL agree for the fit's whole lifetime.
create table public.character_fitting_share (
  token text primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
  fitting_id bigint not null,
  created_at timestamptz not null default now(),
  unique (character_id, fitting_id)
);
create index character_fitting_share_character_id_idx on public.character_fitting_share (character_id);

alter table public.character_fitting_share enable row level security;
create policy "Users manage own fitting share tokens"
  on public.character_fitting_share
  for all
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  )
  with check (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select, insert, update, delete on public.character_fitting_share to authenticated;
grant all on public.character_fitting_share to service_role;
