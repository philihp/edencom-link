-- Shares for one saved fitting, at one of three levels: 'corporation' or
-- 'alliance' widen read access on character_fitting_over_time itself (the
-- policies below) to whoever currently shares that corp/alliance with the
-- owner — no token needed, resolved live off the world-readable
-- character_directory at read time, the same "not frozen at share time"
-- philosophy the mercenary-den alliance sharing uses. 'public' instead mints a token — the
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

-- Everything below runs as the QUERYING user — no SECURITY DEFINER — so every
-- table referenced inside a policy is filtered by its own RLS. That shapes the
-- whole design, the same way it shaped the mercenary-den layer: the owner's
-- corp/alliance must come from the world-readable character_directory (a
-- registration join would come up empty for anyone but the owner), and the
-- audience must be able to read the share rows aimed at them, or the widening
-- policy's probe of the share table would see nothing.

-- The corporations the caller has a character in — the corp-level counterpart
-- of my_alliance_ids() (20260722113000_mercenary_den_alliance_sharing), same
-- invoker-rights shape, reading only the caller's own registration rows.
create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;

grant execute on function public.my_corporation_ids() to authenticated;

-- Members of the audience read the corp/alliance share rows aimed at them —
-- character_mercenary_den_share's "Alliance members read shares to their
-- alliances", adapted to a per-fit share whose audience is derived from the
-- owner's live affiliation rather than stored on the row. Load-bearing for
-- fitting_shared_with_caller() below, which sees exactly the rows this policy
-- (OR'd with "Users manage own fitting shares") exposes. public-level rows are
-- deliberately not exposed: the token is the only key to those, resolved by
-- the service-role client (src/app/fitting/access.ts).
drop policy if exists "Corp/alliance members read fitting shares aimed at them" on public.character_fitting_share;
create policy "Corp/alliance members read fitting shares aimed at them"
  on public.character_fitting_share
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.character_directory owner
      where owner.registration_id = character_fitting_share.character_id
        and (
          (
            character_fitting_share.level = 'corporation'
            and owner.corporation_id in (select public.my_corporation_ids())
          )
          or (
            character_fitting_share.level = 'alliance'
            and owner.alliance_id in (select public.my_alliance_ids())
          )
        )
    )
  );

-- True when the given fit carries a corp/alliance share whose audience the
-- caller currently belongs to — mercenary_den_shared_with_caller's shape, on
-- invoker rights: it reads only what the caller may already read (share rows
-- via the policy above, the world-readable character_directory, their own
-- registrations via my_corporation_ids()/my_alliance_ids()). The parameters
-- are named after the (character_id, fitting_id) pair that is a fit's durable
-- key — which is why the body qualifies them with the function name: both
-- joined tables carry a character_id column of their own, and in a SQL
-- function body an unqualified name that matches a column resolves to the
-- column. An owner with no character_directory row yet (the
-- character-directory job runs daily) resolves to false until the next pass,
-- same as the den layer.
--
-- The dependent policy is dropped before the function because create-or-
-- replace cannot rename an existing function's parameters, so an environment
-- that applied an earlier draft of this migration needs the old function
-- dropped — and its dependent policy first.
drop policy if exists "Corp/alliance members read shared fittings" on public.character_fitting_over_time;
drop function if exists public.fitting_shared_with_caller(uuid, bigint);
create function public.fitting_shared_with_caller(character_id uuid, fitting_id bigint)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.character_fitting_share s
    join public.character_directory owner on owner.registration_id = s.character_id
    where s.character_id = fitting_shared_with_caller.character_id
      and s.fitting_id = fitting_shared_with_caller.fitting_id
      and (
        (s.level = 'corporation' and owner.corporation_id in (select public.my_corporation_ids()))
        or (s.level = 'alliance' and owner.alliance_id in (select public.my_alliance_ids()))
      )
  );
$$;

grant execute on function public.fitting_shared_with_caller(uuid, bigint) to authenticated;

-- The widening itself: a second, additive SELECT policy (Postgres ORs
-- permissive policies for the same role) layered on top of "Users read own
-- fittings", inherited by the security_invoker character_fitting view. An
-- earlier version inlined this with the owner's affiliation joined from
-- registration and no audience policy on the share table — both RLS-filtered
-- as the querying user, so for the corp/alliance mate the subquery always came
-- up empty and the policy never matched anything. (Dropped above, before the
-- function it depends on.)
create policy "Corp/alliance members read shared fittings"
  on public.character_fitting_over_time
  for select
  to authenticated
  using (public.fitting_shared_with_caller(character_id, fitting_id));
