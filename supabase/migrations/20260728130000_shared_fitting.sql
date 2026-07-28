-- Corporation / alliance fittings, authored on the site. ESI exposes only a
-- character's personal fittings (docs/fittings.md), so the in-game Corp and
-- Alliance doctrine folders can't be extracted — instead a member publishes a
-- saved personal fit *as* a corp or alliance fitting here, and everyone with a
-- character in that corp/alliance sees it on /fitting under the Corp/Alliance
-- checkboxes.
--
-- This is its own table rather than owner_scope rows in
-- character_fitting_over_time: that table is the extract's SCD mirror of what
-- ESI reports, and its reconciler closes any current row missing from the ESI
-- snapshot — a site-authored row would be swept as "deleted in game" on the
-- next run. A published fit is a snapshot copy, deliberately not a live link
-- to the personal fit it came from (editing the personal fit later doesn't
-- silently change the doctrine).
--
-- Audience membership follows the mercenary-den sharing model (invoker-rights
-- policies, no SECURITY DEFINER): corp membership from the caller's own
-- registrations, alliance membership via my_alliance_ids() (migration
-- 20260725000000). Publisher identity is a registration uuid; names resolve
-- through the world-readable character_directory.
create table if not exists public.shared_fitting (
  id uuid primary key default gen_random_uuid(),
  audience text not null check (audience in ('corporation', 'alliance')),
  -- Exactly one of the two is set, matching the audience.
  corporation_id bigint,
  alliance_id bigint,
  name text not null,
  description text,
  ship_type_id bigint not null,
  items jsonb not null default '[]'::jsonb,
  -- The publishing character. set null on unlink so the doctrine outlives the
  -- publisher's registration (only the service role can remove it then).
  created_by uuid references public.registration(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((audience = 'corporation') = (corporation_id is not null)),
  check ((audience = 'alliance') = (alliance_id is not null))
);
create index if not exists shared_fitting_corporation_id_idx on public.shared_fitting (corporation_id);
create index if not exists shared_fitting_alliance_id_idx on public.shared_fitting (alliance_id);

alter table public.shared_fitting enable row level security;

-- Members read their corp's / alliance's doctrine fits.
drop policy if exists "Members read corp fittings" on public.shared_fitting;
create policy "Members read corp fittings"
  on public.shared_fitting
  for select
  to authenticated
  using (
    (
      audience = 'corporation'
      and corporation_id in (
        select corporation_id from public.registration
        where user_id = (select auth.uid()) and corporation_id is not null
      )
    )
    or (audience = 'alliance' and alliance_id in (select public.my_alliance_ids()))
  );

-- Publishing: the publisher must be one of the caller's own registrations, and
-- the target must be that character's *current* corp (or its alliance) — you
-- can't publish into a corp you aren't in.
drop policy if exists "Members publish fittings to their corp or alliance" on public.shared_fitting;
create policy "Members publish fittings to their corp or alliance"
  on public.shared_fitting
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.registration r
      left join public.corporation c on c.corporation_id = r.corporation_id
      where r.id = created_by
        and r.user_id = (select auth.uid())
        and (
          (audience = 'corporation' and shared_fitting.corporation_id = r.corporation_id)
          or (audience = 'alliance' and shared_fitting.alliance_id = c.alliance_id)
        )
    )
  );

-- Unpublishing: the publisher takes their own fits back down.
drop policy if exists "Publishers delete own shared fittings" on public.shared_fitting;
create policy "Publishers delete own shared fittings"
  on public.shared_fitting
  for delete
  to authenticated
  using (
    created_by in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select, insert, delete on public.shared_fitting to authenticated;
grant all on public.shared_fitting to service_role;
