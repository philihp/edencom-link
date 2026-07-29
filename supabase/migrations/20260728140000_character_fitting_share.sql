-- Shares for one saved fitting, at one of three levels: 'corporation' or
-- 'alliance' widen read access on character_fitting_over_time itself (the
-- second policy below) to whoever currently shares that corp/alliance with
-- the owner — no token needed, resolved live off registration/corporation at
-- read time, the same "not frozen at share time" philosophy the
-- mercenary-den alliance sharing uses. 'public' instead mints a token — the
-- secret in a /fitting/[characterId]/[fittingId]?token=… link (mirroring
-- shared_asset_token's /ship/[itemId]?token=… pattern) that lets anyone view
-- the fit without signing in, resolved anonymously via the service-role
-- client (src/app/fitting/access.ts). Every level points at the fit itself,
-- never a copy.
--
-- No uniqueness on (character_id, fitting_id): a player can hold several
-- shares for the same fit at once (e.g. both a corp share and a couple of
-- public links handed to different people), each independently revocable.
-- token is still globally unique where present, since it's the sole lookup
-- key for the anonymous path.
--
-- (character_id, fitting_id) rather than character_fitting_over_time's own
-- surrogate `id`: that id is an SCD *version* stamp and changes every time the
-- fit is edited in the client, so a share pinned to it would silently break on
-- the next edit. (character_id, fitting_id) is the fit's durable identity —
-- the same pair /fitting/[characterId]/[fittingId] addresses it by.
create table if not exists public.character_fitting_share (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.registration(id) on delete cascade,
  fitting_id bigint not null,
  level text not null check (level in ('corporation', 'alliance', 'public')),
  -- Required for a public link (the anonymous lookup key), absent for a
  -- corp/alliance share (membership alone gates it — see the policy below).
  token text,
  created_at timestamptz not null default now(),
  check ((level = 'public') = (token is not null))
);
create index if not exists character_fitting_share_fitting_idx
  on public.character_fitting_share (character_id, fitting_id);
create unique index if not exists character_fitting_share_token_idx
  on public.character_fitting_share (token) where token is not null;

alter table public.character_fitting_share enable row level security;

drop policy if exists "Users manage own fitting share tokens" on public.character_fitting_share;
drop policy if exists "Users manage own fitting shares" on public.character_fitting_share;
create policy "Users manage own fitting shares"
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

-- A second, additive SELECT policy (Postgres ORs multiple permissive policies
-- for the same role) layered on top of "Users read own fittings": a fit with
-- a 'corporation' or 'alliance' character_fitting_share row becomes readable
-- to whoever currently shares that corp/alliance with the *owner* — resolved
-- live off registration/corporation at query time, not frozen at share time,
-- same as my_alliance_ids() itself.
drop policy if exists "Corp/alliance members read shared fittings" on public.character_fitting_over_time;
create policy "Corp/alliance members read shared fittings"
  on public.character_fitting_over_time
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.character_fitting_share s
      join public.registration owner on owner.id = s.character_id
      where s.character_id = character_fitting_over_time.character_id
        and s.fitting_id = character_fitting_over_time.fitting_id
        and (
          (
            s.level = 'corporation'
            and owner.corporation_id in (
              select corporation_id from public.registration
              where user_id = (select auth.uid()) and corporation_id is not null
            )
          )
          or (
            s.level = 'alliance'
            and exists (
              select 1 from public.corporation c
              where c.corporation_id = owner.corporation_id
                and c.alliance_id in (select public.my_alliance_ids())
            )
          )
        )
    )
  );
